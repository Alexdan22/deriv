const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const API_TOKEN = 'VX41WSwVGQDET3r'; // Replace with your Deriv API token
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

let isTrading = false; // Prevent overlapping trades
let martingaleStep = 0;
const maxMartingaleSteps = 2; // Maximum steps in the Martingale strategy
let stake = 10; // Initial stake amount

// Function to send data to WebSocket
const sendToWebSocket = (ws, data) => {
  ws.send(JSON.stringify(data));
};

// Function to fetch minimum duration
const getMinDuration = (ws, symbol) => {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      const response = JSON.parse(event.data);

      if (response.error) {
        ws.removeEventListener('message', listener);
        reject(`Error: ${response.error.message}`);
      } else if (response.msg_type === 'contracts_for') {
        ws.removeEventListener('message', listener);

        // Extract minimum duration
        const availableContracts = response.contracts_for.available;
        const minDuration = availableContracts.reduce((min, contract) => {
          const duration = parseDuration(contract.min_contract_duration);
          return duration < min ? duration : min;
        }, Infinity);

        resolve(minDuration);
      }
    };

    ws.addEventListener('message', listener);

    ws.send(
      JSON.stringify({
        contracts_for: symbol,
        currency: 'USD',
      })
    );
  });
};

// Helper function to parse durations (e.g., "1m" => 1 minute)
const parseDuration = (duration) => {
  const unit = duration.slice(-1); // Get the last character (e.g., 'm', 'h', 'd')
  const value = parseInt(duration.slice(0, -1), 10); // Get the numeric part
  switch (unit) {
    case 't': return value; // Ticks
    case 's': return value / 60; // Seconds to minutes
    case 'm': return value; // Minutes
    case 'h': return value * 60; // Hours to minutes
    case 'd': return value * 1440; // Days to minutes
    default: return Infinity; // Unknown duration
  }
};

// Function to place a trade
const placeTrade = (ws, symbol, call, stake, duration) => {
  const contractType = call === 'call' ? 'CALL' : 'PUT'; // Determine contract type based on call
  sendToWebSocket(ws, {
    buy: 1,
    price: stake, // Stake amount
    parameters: {
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      duration: duration,
      duration_unit: 'm', // Minutes
      symbol: 'frx' + symbol,
    },
  });
};

// Function to reset the trading state
const resetTradingState = (ws) => {
  isTrading = false;
  martingaleStep = 0;
  stake = 10; // Reset stake to initial value
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
};

// Webhook listener for TradingView alerts
app.post('/webhook', async (req, res) => {
  const { symbol, call } = req.body; // TradingView sends the ticker and call ('call' or 'put')
  console.log(req.body);

  if (!symbol || !call) {
    return res.status(400).send('Invalid webhook payload');
  }

  if (isTrading) {
    return res.status(200).send('Already trading. Ignoring new alert.');
  }

  isTrading = true;

  // Connect to Deriv WebSocket
  const ws = new WebSocket(WEBSOCKET_URL);

  ws.on('open', async () => {
    console.log('Connected to Deriv API.');

    // Authorize the connection
    sendToWebSocket(ws, { authorize: API_TOKEN });

    ws.on('message', async (data) => {
      const response = JSON.parse(data);

      if (response.msg_type === 'authorize') {
        console.log('Authorized. Fetching minimum duration...');
        try {
          const minDuration = await getMinDuration(ws, 'frx' + symbol); // Use the proper symbol format
          console.log(`Minimum duration for ${symbol}: ${minDuration} minutes`);

          // Place the trade using the minimum duration
          console.log('Placing trade...');
          placeTrade(ws, symbol, call, stake, minDuration);
        } catch (error) {
          console.error('Error fetching minimum duration:', error);
          resetTradingState(ws);
        }
      }

      if (response.msg_type === 'buy') {
        if (response.error) {
          console.error('Error placing trade:', response.error.message);
          resetTradingState(ws);
        } else {
          console.log('Trade placed successfully:', response.buy);
        }
      }

      if (response.msg_type === 'error') {
        console.error('Error:', response.error.message);
        resetTradingState(ws);
      }
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed.');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      resetTradingState(ws);
    });
  });

  res.status(200).send('Webhook received and trade initiated.');
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});
