FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o ext-authz-server .

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /app/ext-authz-server /ext-authz-server
USER nonroot:nonroot
EXPOSE 9001 8080
ENTRYPOINT ["/ext-authz-server"]
