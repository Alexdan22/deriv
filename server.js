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

// Forex symbol mapping
const deriveSymbolMap = {
  frxAUDCAD: 'AUD/CAD',
  frxAUDCHF: 'AUD/CHF',
  frxAUDJPY: 'AUD/JPY',
  frxAUDNZD: 'AUD/NZD',
  frxAUDUSD: 'AUD/USD',
  frxEURAUD: 'EUR/AUD',
  frxEURCAD: 'EUR/CAD',
  frxEURCHF: 'EUR/CHF',
  frxEURGBP: 'EUR/GBP',
  frxEURJPY: 'EUR/JPY',
  frxEURNZD: 'EUR/NZD',
  frxEURUSD: 'EUR/USD',
  frxGBPAUD: 'GBP/AUD',
  frxGBPCAD: 'GBP/CAD',
  frxGBPCHF: 'GBP/CHF',
  frxGBPJPY: 'GBP/JPY',
  frxGBPNOK: 'GBP/NOK',
  frxGBPNZD: 'GBP/NZD',
  frxGBPUSD: 'GBP/USD',
  frxNZDJPY: 'NZD/JPY',
  frxNZDUSD: 'NZD/USD',
  frxUSDCAD: 'USD/CAD',
  frxUSDCHF: 'USD/CHF',
  frxUSDJPY: 'USD/JPY',
  frxUSDNOK: 'USD/NOK',
  frxUSDPLN: 'USD/PLN',
  frxUSDSEK: 'USD/SEK',
};

// Function to send data to WebSocket
const sendToWebSocket = (ws, data) => {
  ws.send(JSON.stringify(data));
};

// Webhook listener for TradingView alerts
app.post('/webhook', async (req, res) => {
  const { symbol, call } = req.body; // TradingView sends the symbol and call ('up' or 'down')
  console.log(req.body);

  if (!symbol || !call) {
    return res.status(400).send('Invalid webhook payload');
  }

  if (!deriveSymbolMap[symbol]) {
    console.log(`Invalid or unsupported symbol: ${symbol}`);
    return res.status(400).send('Non-tradeable or unsupported asset');
  }

  console.log(`Received alert for ${symbol} - Call: ${call}`);

  if (isTrading) {
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

    if (response.msg_type === 'authorize') {
      console.log('Authorized. Placing initial trade...');
      placeTrade(ws, symbol, call, stake);
    }

    if (response.msg_type === 'buy') {
      if (response.error) {
        console.error('Error placing trade:', response.error.message);
        resetTradingState(ws);
      } else {
        console.log('Trade placed successfully:', response.buy);
      }
    }

    if (response.msg_type === 'proposal_open_contract') {
      const { contract } = response.proposal_open_contract;
      if (contract.status !== 'open') {
        if (contract.profit > 0) {
          console.log('Trade won. Returning to idle state.');
          resetTradingState(ws);
        } else {
          console.log('Trade lost. Entering Martingale strategy...');
          martingaleStep++;
          if (martingaleStep <= maxMartingaleSteps) {
            stake *= 2; // Double the stake for Martingale
            placeTrade(ws, symbol, call, stake);
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
const placeTrade = (ws, symbol, call, stake) => {
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
      symbol: symbol,
    },
  });
};

// Function to reset the trading state
const resetTradingState = (ws) => {
  isTrading = false;
  martingaleStep = 0;
  stake = 10; // Reset stake to initial value
  ws.close();
};

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});
