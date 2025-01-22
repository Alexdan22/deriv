const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const API_TOKEN = 'VX41WSwVGQDET3r'; // Replace with your Deriv API token
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const trades = new Map(); // Track each trade by its symbol or unique ID

let ws; // WebSocket instance

// Function to send data to WebSocket
const sendToWebSocket = (ws, data) => {
  ws.send(JSON.stringify(data));
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

// Function to place a trade
const placeTrade = (ws, trade) => {
  const { symbol, call, stake, duration } = trade;
  const contractType = call === 'call' ? 'CALL' : 'PUT';

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
      symbol: 'frx' + symbol,
    },
  });
};

// Function to handle trade results
const handleTradeResult = (trade, contract) => {
  const { symbol } = trade;

  if (contract.status !== 'open') {
    const tradePnL = contract.profit;
    trade.totalPnL += tradePnL;

    if (tradePnL > 0) {
      console.log(`Trade for ${symbol} won. Returning to idle state.`);
      trades.delete(symbol);
    } else {
      trade.martingaleStep++;
      if (trade.martingaleStep <= trade.maxMartingaleSteps) {
        trade.stake *= 2;
        console.log(
          `Trade for ${symbol} lost. Entering Martingale step ${trade.martingaleStep} with stake ${trade.stake} USD.`
        );
        placeTrade(ws, trade);
      } else {
        console.log(
          `All Martingale steps for ${symbol} lost. Logging total PnL: ${trade.totalPnL.toFixed(
            2
          )} USD. Returning to idle state.`
        );
        trades.delete(symbol);
      }
    }
  }
};

// Function to create a WebSocket connection
const createWebSocket = () => {
  ws = new WebSocket(WEBSOCKET_URL);

  ws.on('open', () => {
    console.log('Connected to Deriv API.');
    sendToWebSocket(ws, { authorize: API_TOKEN });
  });

  ws.on('message', (data) => {
    const response = JSON.parse(data);

    if (response.msg_type === 'authorize') {
      console.log('Authorized and ready to receive alerts.');
    }

    if (response.msg_type === 'buy') {
      if (response.error) {
        console.error('Error placing trade:', response.error.message);
        const symbol = response.error.symbol;
        if (symbol && trades.has(symbol)) {
          trades.delete(symbol);
        }
      } else {
        console.log('Trade placed successfully:', response.buy);
      }
    }

    if (response.msg_type === 'proposal_open_contract') {
      const contract = response.proposal_open_contract;
      const symbol = contract.symbol.slice(3); // Extract symbol from "frxUSDJPY"

      if (trades.has(symbol)) {
        handleTradeResult(trades.get(symbol), contract);
      }
    }

    if (response.msg_type === 'error') {
      console.error('Error:', response.error.message);
    }
  });

  ws.on('close', () => {
    console.error('WebSocket connection closed. Reconnecting in 5 seconds...');
    setTimeout(createWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
};

// Start WebSocket connection
createWebSocket();

// Webhook listener for TradingView alerts
app.post('/webhook', async (req, res) => {
  const { symbol, call } = req.body;

  if (!symbol || !call) {
    return res.status(400).send('Invalid webhook payload');
  }

  if (trades.has(symbol)) {
    return res.status(200).send(`Trade for ${symbol} is already in progress.`);
  }

  console.log(`Received alert for ${symbol} - Call: ${call}`);

  const trade = {
    symbol,
    call,
    stake: 10, // Initial stake
    martingaleStep: 0,
    maxMartingaleSteps: 3,
    totalPnL: 0,
  };

  trades.set(symbol, trade);

  try {
    console.log('Fetching minimum duration...');
    const minDuration = await getMinDuration(ws, 'frx' + symbol);
    console.log(`Minimum duration for ${symbol}: ${minDuration} minutes`);
    trade.duration = minDuration;

    console.log('Placing initial trade...');
    placeTrade(ws, trade);
  } catch (error) {
    console.error('Error processing alert:', error);
    trades.delete(symbol);
  }

  res.status(200).send('Webhook received and trade initiated.');
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});
