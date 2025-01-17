// Import the WebSocket library
const WebSocket = require('ws');

// Replace 'your-api-token-here' with your actual Deriv API token
const API_TOKEN = 'zIQzxBhBpPnileS';
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

// Create a WebSocket connection
const ws = new WebSocket(WEBSOCKET_URL);

// Function to send data to WebSocket
const sendToWebSocket = (data) => {
  ws.send(JSON.stringify(data));
};

// Listen to WebSocket messages
ws.on('message', (data) => {
  const response = JSON.parse(data);
  console.log('Response:', response);

  if (response.msg_type === 'authorize') {
    console.log('Authorized!');

    // Request ticks for a specific market
    sendToWebSocket({
      ticks: 'R_100' // Replace with your preferred market symbol
    });
  }

  if (response.msg_type === 'tick') {
    console.log(`Tick: ${response.tick.symbol} | Price: ${response.tick.quote}`);

    // Example: Place a trade when a condition is met
    const price = response.tick.quote;
    if (price > 100) { // Replace with your trading condition
      sendToWebSocket({
        buy: 1,
        price: 10, // Amount to trade
        parameters: {
          amount: 10,
          basis: 'stake',
          contract_type: 'CALL', // 'CALL' or 'PUT'
          currency: 'USD',
          duration: 1,
          duration_unit: 'm',
          symbol: 'R_100'
        }
      });
    }
  }

  if (response.msg_type === 'buy') {
    console.log('Trade Successful:', response.buy);
  }

  if (response.msg_type === 'error') {
    console.error('Error:', response.error.message);
  }
});

// Handle WebSocket connection open
ws.on('open', () => {
  console.log('WebSocket connected.');

  // Authorize with your API token
  sendToWebSocket({
    authorize: API_TOKEN
  });
});

// Handle WebSocket errors
ws.on('error', (error) => {
  console.error('WebSocket Error:', error);
});

// Handle WebSocket close
ws.on('close', () => {
  console.log('WebSocket connection closed.');
});
