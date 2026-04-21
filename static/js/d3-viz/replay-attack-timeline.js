// Replay Attack Timeline Visualization
// Shows how nonce checking prevents replay attacks over time

function initReplayAttackTimeline() {
  const containerId = '#d3-viz-replay-attack-timeline';
  const container = d3.select(containerId);

  if (container.empty()) return;

  // Timeline events
  const events = [
    {
      time: 0,
      seconds: 0,
      label: 'T=0s: First Valid Request',
      amount: 50,
      nonce: 'nonce_12345',
      status: 'ALLOWED',
      color: '#51cf66',
      redisAction: 'SETNX nonce_12345 → Success',
      description: 'First request arrives with valid nonce'
    },
    {
      time: 30,
      seconds: 30,
      label: 'T=30s: Attacker Replays',
      amount: 50,
      nonce: 'nonce_12345',
      status: 'REJECTED',
      color: '#ff6b6b',
      redisAction: 'GET nonce_12345 → FOUND',
      description: 'Attacker replays same request'
    },
    {
      time: 60,
      seconds: 60,
      label: 'T=60s: Second Replay Attempt',
      amount: 50,
      nonce: 'nonce_12345',
      status: 'REJECTED',
      color: '#ff6b6b',
      redisAction: 'GET nonce_12345 → FOUND',
      description: 'Attacker tries again'
    },
    {
      time: 90,
      seconds: 90,
      label: 'T=90s: Third Replay Attempt',
      amount: 50,
      nonce: 'nonce_12345',
      status: 'REJECTED',
      color: '#ff6b6b',
      redisAction: 'GET nonce_12345 → FOUND',
      description: 'Attacker persistence - still blocked'
    },
    {
      time: 3600,
      seconds: 3600,
      label: 'T=3600s: Nonce Expires',
      amount: 50,
      nonce: 'nonce_12345',
      status: 'EXPIRED',
      color: '#868e96',
      redisAction: 'Redis TTL expires',
      description: 'Nonce removed from Redis after 1 hour'
    }
  ];

  // Dimensions - handle responsive sizing
  const margin = { top: 40, right: 40, bottom: 80, left: 80 };
  let containerWidth = container.node().clientWidth;
  // Fallback for containers without explicit width
  if (!containerWidth || containerWidth === 0) {
    containerWidth = 800;
  }
  const width = containerWidth - margin.left - margin.right;
  const height = 500 - margin.top - margin.bottom;

  // Create SVG
  const svg = container
    .append('svg')
    .attr('width', width + margin.left + margin.right)
    .attr('height', height + margin.top + margin.bottom)
    .append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Scales
  const xScale = d3.scaleLinear()
    .domain([0, 3600])
    .range([0, width]);

  // Fixed y-position for timeline baseline
  const timelineY = height - 150;

  // X-axis (Time)
  svg.append('g')
    .attr('transform', `translate(0,${timelineY})`)
    .call(d3.axisBottom(xScale).ticks(6).tickFormat(d => d + 's'))
    .append('text')
    .attr('x', width / 2)
    .attr('y', 40)
    .attr('fill', 'black')
    .style('font-size', '14px')
    .style('font-weight', 'bold')
    .text('Time (seconds)');

  // Y-axis label
  svg.append('text')
    .attr('transform', 'rotate(-90)')
    .attr('y', 0 - margin.left)
    .attr('x', 0 - timelineY / 2)
    .attr('dy', '1em')
    .style('text-anchor', 'middle')
    .style('font-size', '14px')
    .style('font-weight', 'bold')
    .text('Request Status');

  // Draw vertical timeline line
  svg.append('line')
    .attr('x1', 0)
    .attr('x2', width)
    .attr('y1', timelineY)
    .attr('y2', timelineY)
    .attr('stroke', '#dee2e6')
    .attr('stroke-width', 2);

  // Draw events
  const eventGroups = svg.selectAll('.event')
    .data(events.slice(0, 4)) // Exclude legend
    .enter()
    .append('g')
    .attr('class', 'event');

  // Event circles
  eventGroups.append('circle')
    .attr('cx', d => xScale(d.seconds))
    .attr('cy', timelineY)
    .attr('r', 8)
    .attr('fill', d => d.color)
    .attr('stroke', 'white')
    .attr('stroke-width', 3)
    .style('cursor', 'pointer');

  // Helper function to get label y position based on event index
  const getLabelY = (index) => {
    const spacing = 70;
    return timelineY - (spacing + index * 40);
  };

  // Event labels with background
  eventGroups.append('rect')
    .attr('x', d => xScale(d.seconds) - 65)
    .attr('y', (d, i) => getLabelY(i) - 20)
    .attr('width', 130)
    .attr('height', 40)
    .attr('rx', 4)
    .attr('fill', d => d.color)
    .attr('opacity', 0.15)
    .attr('stroke', d => d.color)
    .attr('stroke-width', 2);

  // Event text
  eventGroups.append('text')
    .attr('x', d => xScale(d.seconds))
    .attr('y', (d, i) => getLabelY(i))
    .attr('text-anchor', 'middle')
    .attr('dy', '0.35em')
    .style('font-size', '12px')
    .style('font-weight', 'bold')
    .style('fill', d => d.color)
    .style('pointer-events', 'auto')
    .text(d => d.status);

  // Time labels below timeline
  eventGroups.append('text')
    .attr('x', d => xScale(d.seconds))
    .attr('y', timelineY + 20)
    .attr('text-anchor', 'middle')
    .style('font-size', '11px')
    .style('fill', '#666')
    .style('pointer-events', 'auto')
    .text(d => `${d.seconds}s`);

  // Legend
  const legendY = timelineY + 60;
  const legend = svg.append('g')
    .attr('class', 'legend')
    .attr('transform', `translate(0, ${legendY})`);

  const legendData = [
    { label: '✓ Allowed', color: '#51cf66' },
    { label: '✗ Rejected', color: '#ff6b6b' },
    { label: 'Expired', color: '#868e96' }
  ];

  legendData.forEach((item, i) => {
    const legendItem = legend.append('g')
      .attr('transform', `translate(${i * 180}, 0)`);

    legendItem.append('circle')
      .attr('r', 6)
      .attr('fill', item.color)
      .style('pointer-events', 'none');

    legendItem.append('text')
      .attr('x', 15)
      .attr('dy', '0.32em')
      .style('font-size', '12px')
      .style('pointer-events', 'none')
      .text(item.label);
  });

  // Info panel
  const infoPanel = svg.append('g')
    .attr('class', 'info-panel')
    .attr('transform', `translate(${Math.max(width - 250, 10)}, 10)`);

  infoPanel.append('rect')
    .attr('width', 240)
    .attr('height', 100)
    .attr('rx', 4)
    .attr('fill', '#f8f9fa')
    .attr('stroke', '#dee2e6')
    .attr('stroke-width', 1)
    .style('pointer-events', 'none');

  const infoPanelText = infoPanel.append('g')
    .style('pointer-events', 'none');

  infoPanelText.append('text')
    .attr('x', 10)
    .attr('y', 20)
    .style('font-size', '12px')
    .style('font-weight', 'bold')
    .text('Nonce TTL: 3600s');

  infoPanelText.append('text')
    .attr('x', 10)
    .attr('y', 40)
    .style('font-size', '11px')
    .text('Nonce stored in Redis');

  infoPanelText.append('text')
    .attr('x', 10)
    .attr('y', 58)
    .style('font-size', '11px')
    .text('Expires after 1 hour');

  infoPanelText.append('text')
    .attr('x', 10)
    .attr('y', 76)
    .style('font-size', '11px')
    .text('Prevents replay attacks');

  // Add interactivity
  eventGroups.on('mouseover', function(event, d) {
    // Highlight this event
    d3.select(this).select('circle')
      .transition()
      .duration(200)
      .attr('r', 12);

    // Find the index of this event to position tooltip correctly
    const eventIndex = events.indexOf(d);

    // Show tooltip
    const tooltip = svg.append('g')
      .attr('class', 'tooltip')
      .attr('pointer-events', 'none');

    const tooltipX = xScale(d.seconds);
    const tooltipY = getLabelY(eventIndex) - 100;

    tooltip.append('rect')
      .attr('x', tooltipX - 80)
      .attr('y', tooltipY)
      .attr('width', 160)
      .attr('height', 70)
      .attr('rx', 4)
      .attr('fill', '#2d3748')
      .attr('opacity', 0.9);

    tooltip.append('text')
      .attr('x', tooltipX)
      .attr('y', tooltipY + 20)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('font-weight', 'bold')
      .style('fill', 'white')
      .text(d.label);

    tooltip.append('text')
      .attr('x', tooltipX)
      .attr('y', tooltipY + 40)
      .attr('text-anchor', 'middle')
      .style('font-size', '11px')
      .style('fill', '#e2e8f0')
      .text(d.redisAction);

    tooltip.append('text')
      .attr('x', tooltipX)
      .attr('y', tooltipY + 60)
      .attr('text-anchor', 'middle')
      .style('font-size', '11px')
      .style('fill', '#cbd5e0')
      .text(d.description);
  })
  .on('mouseout', function() {
    d3.select(this).select('circle')
      .transition()
      .duration(200)
      .attr('r', 8);

    svg.selectAll('.tooltip').remove();
  });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initReplayAttackTimeline);
} else {
  initReplayAttackTimeline();
}
