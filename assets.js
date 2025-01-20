const WebSocket = require('ws');

const API_TOKEN = 'VX41WSwVGQDET3r'; // Replace with your Deriv API token
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

// Connect to Deriv WebSocket
const ws = new WebSocket(WEBSOCKET_URL);

// Function to send data to WebSocket
const sendToWebSocket = (ws, data) => {
  ws.send(JSON.stringify(data));
};

// Function to handle WebSocket responses
ws.on('open', () => {
  console.log('Connected to Deriv API.');

  // Authorize the connection
  sendToWebSocket(ws, { authorize: API_TOKEN });
});

ws.on('message', (data) => {
  const response = JSON.parse(data);

  if (response.msg_type === 'authorize') {
    console.log('Authorized. Fetching tradeable assets list...');
    sendToWebSocket(ws, { active_symbols: 'brief' }); // Fetch the list of tradeable assets
  }

  if (response.msg_type === 'active_symbols') {
    console.log('Tradeable Assets List:');
    response.active_symbols.forEach((symbol) => {
      console.log(`Symbol: ${symbol.symbol}, Display Name: ${symbol.display_name}, Market: ${symbol.market_display_name}`);
    });
    ws.close(); // Close the connection after fetching
  }

  if (response.msg_type === 'error') {
    console.error('Error:', response.error.message);
    ws.close();
  }
});

ws.on('close', () => {
  console.log('WebSocket connection closed.');
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});
