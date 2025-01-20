const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const API_TOKEN = 'VX41WSwVGQDET3r';
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

let isTrading = false; // Prevent overlapping trades
let martingaleStep = 0;
const maxMartingaleSteps = 2; // Maximum steps in the Martingale strategy
let stake = 10; // Initial stake amount

// Function to send data to WebSocket
const sendToWebSocket = (ws, data) => {
  try {
    ws.send(JSON.stringify(data));
    console.log('Sent to WebSocket:', data);
  } catch (err) {
    console.error('Error sending data to WebSocket:', err);
  }
};

// Webhook listener for TradingView alerts
app.post('/webhook', async (req, res) => {
  const { ticker, call } = req.body; // TradingView sends the ticker and call ('up' or 'down')
  console.log('Webhook Payload:', req.body);

  if (!ticker || !call) {
    console.error('Invalid webhook payload. Missing "ticker" or "call".');
    return res.status(400).send('Invalid webhook payload');
  }

  if (isTrading) {
    console.log('Already trading. Ignoring new alert.');
    return res.status(200).send('Already trading. Ignoring new alert.');
  }

  isTrading = true;

  // Connect to Deriv WebSocket
  const ws = new WebSocket(WEBSOCKET_URL);

  ws.on('open', () => {
    console.log('Connected to Deriv API.');
    sendToWebSocket(ws, { authorize: API_TOKEN });
  });

  ws.on('message', (data) => {
    const response = JSON.parse(data);
    console.log('Response:', response);

    if (response.msg_type === 'authorize') {
      console.log('Authorized. Placing initial trade...');
      placeTrade(ws, ticker, call, stake);
    }

    if (response.msg_type === 'buy') {
      console.log('Trade placed successfully:', response.buy);
    }

    if (response.msg_type === 'proposal_open_contract') {
      const { status, profit } = response.proposal_open_contract;
      console.log('Contract Update:', response.proposal_open_contract);

      if (status !== 'open') {
        console.log(`Trade ${status}. Profit: ${profit}`);
        if (profit > 0) {
          console.log('Trade won. Returning to idle state.');
          resetTradingState(ws);
        } else {
          console.log('Trade lost. Entering Martingale strategy...');
          martingaleStep++;
          if (martingaleStep <= maxMartingaleSteps) {
            stake *= 2; // Double the stake for Martingale
            placeTrade(ws, ticker, call, stake);
          } else {
            console.log('Martingale steps completed. Returning to idle state.');
            resetTradingState(ws);
          }
        }
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

  res.status(200).send('Webhook received and trade initiated.');
});

// Function to place a trade
const placeTrade = (ws, ticker, call, stake) => {
  const contractType = call === 'up' ? 'CALL' : 'PUT'; // Determine contract type based on call
  sendToWebSocket(ws, {
    buy: 1,
    price: stake, // Stake amount
    parameters: {
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      duration: 1,
      duration_unit: 'm',
      symbol: ticker,
    },
  });
  console.log(`Trade initiated: ${contractType} on ${ticker} with stake ${stake}`);
};

// Function to reset the trading state
const resetTradingState = (ws) => {
  isTrading = false;
  martingaleStep = 0;
  stake = 10; // Reset stake to initial value
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  } catch (err) {
    console.error('Error closing WebSocket:', err);
  }
  console.log('Trading state reset. Ready for the next trade.');
};

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});
