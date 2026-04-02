package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"

	core "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	auth "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	envoy_type "github.com/envoyproxy/go-control-plane/envoy/type/v3"
	"google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
)

// Config holds the authorization server configuration.
type Config struct {
	// Users maps username to password
	Users map[string]string
	// AllowedPaths are paths that bypass auth entirely
	AllowedPaths []string
}

// AuthServer implements the Envoy ext_authz gRPC service.
type AuthServer struct {
	auth.UnimplementedAuthorizationServer
	config Config
}

// Check is called by Envoy for every request that matches the AuthorizationPolicy.
func (s *AuthServer) Check(_ context.Context, req *auth.CheckRequest) (*auth.CheckResponse, error) {
	httpReq := req.GetAttributes().GetRequest().GetHttp()
	path := httpReq.GetPath()
	method := httpReq.GetMethod()
	headers := httpReq.GetHeaders()

	log.Printf("[ext-authz] %s %s", method, path)

	// Allow health checks and public paths
	for _, allowed := range s.config.AllowedPaths {
		if strings.HasPrefix(path, allowed) {
			return allowResponse("allowed-path"), nil
		}
	}

	// Extract Authorization header
	authHeader, exists := headers["authorization"]
	if !exists {
		log.Printf("[ext-authz] DENIED: no authorization header for %s %s", method, path)
		return deniedResponse(401, "Authorization header required"), nil
	}

	// Only Basic auth supported
	if !strings.HasPrefix(authHeader, "Basic ") {
		log.Printf("[ext-authz] DENIED: unsupported auth scheme for %s %s", method, path)
		return deniedResponse(401, "Only Basic auth is supported"), nil
	}

	username, password, ok := parseBasicAuth(authHeader)
	if !ok {
		log.Printf("[ext-authz] DENIED: malformed basic auth for %s %s", method, path)
		return deniedResponse(401, "Malformed Basic auth header"), nil
	}

	// Validate credentials
	expectedPassword, userExists := s.config.Users[username]
	if !userExists || expectedPassword != password {
		log.Printf("[ext-authz] DENIED: invalid credentials for user=%s on %s %s", username, method, path)
		return deniedResponse(403, "Invalid credentials"), nil
	}

	log.Printf("[ext-authz] ALLOWED: user=%s on %s %s", username, method, path)

	// Allowed — inject upstream headers with user identity
	return &auth.CheckResponse{
		Status: &status.Status{Code: int32(codes.OK)},
		HttpResponse: &auth.CheckResponse_OkResponse{
			OkResponse: &auth.OkHttpResponse{
				Headers: []*core.HeaderValueOption{
					{
						Header: &core.HeaderValue{Key: "x-auth-user", Value: username},
					},
					{
						Header: &core.HeaderValue{Key: "x-auth-decision", Value: "allowed"},
					},
				},
			},
		},
	}, nil
}

func allowResponse(reason string) *auth.CheckResponse {
	return &auth.CheckResponse{
		Status: &status.Status{Code: int32(codes.OK)},
		HttpResponse: &auth.CheckResponse_OkResponse{
			OkResponse: &auth.OkHttpResponse{
				Headers: []*core.HeaderValueOption{
					{
						Header: &core.HeaderValue{Key: "x-auth-decision", Value: reason},
					},
				},
			},
		},
	}
}

func deniedResponse(httpStatus int, message string) *auth.CheckResponse {
	return &auth.CheckResponse{
		Status: &status.Status{Code: int32(codes.PermissionDenied)},
		HttpResponse: &auth.CheckResponse_DeniedHttpResponse{
			DeniedHttpResponse: &auth.DeniedHttpResponse{
				Status: &envoy_type.HttpStatus{
					Code: envoy_type.StatusCode(httpStatus),
				},
				Headers: []*core.HeaderValueOption{
					{
						Header: &core.HeaderValue{Key: "x-auth-decision", Value: "denied"},
					},
					{
						Header: &core.HeaderValue{Key: "content-type", Value: "application/json"},
					},
				},
				Body: fmt.Sprintf(`{"error": "%s"}`, message),
			},
		},
	}
}

func parseBasicAuth(header string) (string, string, bool) {
	encoded := strings.TrimPrefix(header, "Basic ")
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", false
	}
	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func startHealthServer(port string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})
	log.Printf("[ext-authz] Health server listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("Health server failed: %v", err)
	}
}

func main() {
	grpcPort := getEnv("GRPC_PORT", "9001")
	healthPort := getEnv("HEALTH_PORT", "8080")

	config := Config{
		AllowedPaths: strings.Split(getEnv("ALLOWED_PATHS", "/healthz,/readyz,/public"), ","),
	}

	usersJSON := getEnv("USERS_JSON", `{"admin":"admin","viewer":"viewer123"}`)
	if err := json.Unmarshal([]byte(usersJSON), &config.Users); err != nil {
		log.Fatalf("Failed to parse USERS_JSON: %v", err)
	}

	log.Printf("[ext-authz] Loaded %d users, allowed paths: %v", len(config.Users), config.AllowedPaths)

	// Health server in background
	go startHealthServer(healthPort)

	// gRPC ext_authz server
	listener, err := net.Listen("tcp", ":"+grpcPort)
	if err != nil {
		log.Fatalf("Failed to listen on port %s: %v", grpcPort, err)
	}

	grpcServer := grpc.NewServer()
	auth.RegisterAuthorizationServer(grpcServer, &AuthServer{config: config})

	log.Printf("[ext-authz] gRPC server listening on :%s", grpcPort)
	if err := grpcServer.Serve(listener); err != nil {
		log.Fatalf("gRPC server failed: %v", err)
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
