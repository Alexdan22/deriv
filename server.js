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
  ws.send(JSON.stringify(data));
};

// Function to fetch supported durations for the given symbol
const getSupportedDurations = (ws, symbol) => {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      const response = JSON.parse(event.data);
      if (response.error) {
        reject(response.error.message);
        ws.removeEventListener('message', listener);
      } else if (response.msg_type === 'contracts_for') {
        ws.removeEventListener('message', listener);
        resolve(response.contracts_for.available);
      }
    };

    ws.addEventListener('message', listener);

    sendToWebSocket(ws, {
      contracts_for: 'frx' + symbol,
      currency: 'USD',
    });
  });
};

// Webhook listener for TradingView alerts
app.post('/webhook', async (req, res) => {
  const { symbol, call } = req.body; // TradingView sends the ticker and call ('call' or 'put')
  console.log(req.body);

  if (!symbol || !call) {
    return res.status(400).send('Invalid webhook payload');
  }

  console.log(`Received alert for ${symbol} - Call: ${call}`);

  if (isTrading) {
    return res.status(200).send('Already trading. Ignoring new alert.');
  }

  isTrading = true;

  const ws = new WebSocket(WEBSOCKET_URL);
  let responseSent = false; // Flag to track if response is sent

  const sendErrorResponse = (errorMessage) => {
    if (!responseSent) {
      res.status(400).send(errorMessage);
      responseSent = true;
    }
    resetTradingState(ws);
  };

  ws.on('open', async () => {
    console.log('Connected to Deriv API.');
    sendToWebSocket(ws, { authorize: API_TOKEN });

    ws.on('message', async (data) => {
      const response = JSON.parse(data);

      if (response.msg_type === 'authorize') {
        console.log('Authorized. Fetching supported durations...');
        try {
          const supportedDurations = await getSupportedDurations(ws, symbol);

          const is1mSupported = supportedDurations.some(
            (duration) =>
              duration.contract_type === (call === 'call' ? 'CALL' : 'PUT') &&
              duration.min_contract_duration === '1m'
          );

          if (!is1mSupported) {
            console.log('1-minute duration is not supported for this asset.');
            sendErrorResponse('1-minute duration not supported for this asset.');
            return;
          }

          console.log('1-minute duration supported. Placing initial trade...');
          placeTrade(ws, symbol, call, stake);

          if (!responseSent) {
            res.status(200).send('Trade initiated successfully.');
            responseSent = true;
          }
        } catch (error) {
          console.error('Error fetching supported durations:', error);
          sendErrorResponse('Failed to fetch supported durations.');
        }
      }

      if (response.msg_type === 'buy') {
        if (response.error) {
          console.error('Error placing trade:', response.error.message);
          sendErrorResponse('Error placing trade: ' + response.error.message);
        } else {
          console.log('Trade placed successfully:', response.buy);
        }
      }

      if (response.msg_type === 'error') {
        console.error('Error:', response.error.message);
        sendErrorResponse('Error: ' + response.error.message);
      }
    });
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed.');
    resetTradingState(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    sendErrorResponse('WebSocket error: ' + error.message);
  });
});


// Function to place a trade
const placeTrade = (ws, symbol, call, stake) => {
  const contractType = call === 'call' ? 'CALL' : 'PUT'; // Determine contract type based on call
  sendToWebSocket(ws, {
    buy: 1,
    price: stake, // Stake amount
    parameters: {
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      duration: 2,
      duration_unit: 'm',
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

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});
