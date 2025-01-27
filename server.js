const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const API_TOKENS = [
  'VX41WSwVGQDET3r', // Replace with your actual API tokens
  '44TRhSy7NFXLsSl'
];
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const PING_INTERVAL = 30000;
let wsConnections = [];

// Helper function: Send data to WebSocket
const sendToWebSocket = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.warn('WebSocket is not open. Data not sent:', data);
  }
};

// Helper function: Parse durations
const parseDuration = (duration) => {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);
  switch (unit) {
    case 't': return value;
    case 's': return value / 60;
    case 'm': return value;
    case 'h': return value * 60;
    case 'd': return value * 1440;
    default: return Infinity;
  }
};

// Function to fetch minimum duration for a symbol
const getMinDuration = (ws, symbol) => {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      const response = JSON.parse(event.data);

      if (response.error) {
        ws.removeEventListener('message', listener);
        reject(`Error: ${response.error.message}`);
      } else if (response.msg_type === 'contracts_for') {
        ws.removeEventListener('message', listener);

        const availableContracts = response.contracts_for.available;
        const minDuration = availableContracts.reduce((min, contract) => {
          const duration = parseDuration(contract.min_contract_duration);
          return duration < min ? duration : min;
        }, Infinity);

        resolve(minDuration);
      }
    };

    ws.addEventListener('message', listener);

    sendToWebSocket(ws, {
      contracts_for: symbol,
      currency: 'USD',
    });
  });
};

// Function to place a trade
const placeTrade = (ws, trade) => {
  const { symbol, call, stake, duration } = trade;
  const contractType = call === 'call' ? 'CALL' : 'PUT';

  try {
    sendToWebSocket(ws, {
      buy: 1,
      price: stake,
      parameters: {
        amount: stake,
        basis: 'stake',
        contract_type: contractType,
        currency: 'USD',
        duration: duration,
        duration_unit: 'm',
        symbol: symbol,
      },
    });
    console.log(`Trade placed: ${symbol}, ${contractType}, Stake: ${stake}, Duration: ${duration}`);
  } catch (error) {
    console.error(`Error placing trade for ${symbol}:`, error);
  }
};

// Function to create WebSocket connection for each account
const createWebSocketConnections = () => {
  wsConnections = API_TOKENS.map((apiToken) => {
    const ws = new WebSocket(WEBSOCKET_URL);

    ws.on('open', () => {
      console.log(`Connected to Deriv API for token: ${apiToken}`);
      sendToWebSocket(ws, { authorize: apiToken });

      setInterval(() => {
        sendToWebSocket(ws, { ping: 1 });
      }, PING_INTERVAL);
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data);

      if (response.error) {
        console.error(`Error from WebSocket: ${response.error.message}`);
      }

    });

    ws.on('close', () => {
      console.error('WebSocket connection closed. Reconnecting...');
      setTimeout(() => createWebSocketConnections(), 5000);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    return ws;
  });
};

// Webhook listener for TradingView alerts
app.post('/webhook', async (req, res) => {
  const { symbol, call } = req.body;

  if (!symbol || !call) {
    console.error('Invalid webhook payload:', req.body);
    return res.status(400).send('Invalid webhook payload');
  }

  const normalizedSymbol = 'frx' + symbol; // Normalize symbol
  console.log(`Webhook received for symbol: ${normalizedSymbol}, call: ${call}`);

  const trade = {
    symbol: normalizedSymbol,
    call,
    stake: 10, // Fixed stake for each trade
    duration: null,
  };

  try {
    // Fetch the minimum duration for the symbol from the first connection (all connections should have the same data)
    const minDuration = await getMinDuration(wsConnections[0], normalizedSymbol);
    trade.duration = minDuration;

    console.log(`Minimum duration for ${normalizedSymbol}: ${minDuration}`);

    // Place the trade on all accounts
    wsConnections.forEach((ws) => {
      placeTrade(ws, trade);
    });
  } catch (error) {
    console.error('Error processing alert:', error);
  }

  res.status(200).send('Webhook received and trade initiated.');
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});

// Start WebSocket connections
createWebSocketConnections();
