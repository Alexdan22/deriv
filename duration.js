const WebSocket = require('ws');

// Deriv API constants
const API_TOKEN = 'VX41WSwVGQDET3r'; // Replace with your API token
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

// Function to send data to WebSocket
const sendToWebSocket = (ws, data) => {
  ws.send(JSON.stringify(data));
};

// Function to get supported durations for a symbol
const getSupportedDurations = (ws, symbol) => {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      const response = JSON.parse(event.data);

      if (response.error) {
        ws.removeEventListener('message', listener);
        reject(`Error: ${response.error.message}`);
      } else if (response.msg_type === 'contracts_for') {
        ws.removeEventListener('message', listener);
        resolve(response.contracts_for.available);
      }
    };

    ws.addEventListener('message', listener);

    sendToWebSocket(ws, {
      contracts_for: symbol,
      currency: 'USD',
    });
  });
};

// Main function
const fetchDurations = async (symbol) => {
  const ws = new WebSocket(WEBSOCKET_URL);

  ws.on('open', async () => {
    console.log('Connected to Deriv API.');

    // Authorize the connection
    sendToWebSocket(ws, { authorize: API_TOKEN });

    ws.on('message', async (data) => {
      const response = JSON.parse(data);

      if (response.msg_type === 'authorize') {
        console.log('Authorized. Fetching supported durations...');
        try {
          const durations = await getSupportedDurations(ws, symbol);
          console.log(`Supported durations for ${symbol}:`, durations);
          ws.close();
        } catch (error) {
          console.error('Error fetching durations:', error);
          ws.close();
        }
      }
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed.');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
};

// Replace 'frxAUDUSD' with your desired symbol
fetchDurations('frxAUDUSD');
