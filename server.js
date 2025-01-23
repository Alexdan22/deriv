const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const axios = require('axios');

const API_TOKEN = 'VX41WSwVGQDET3r'; // Replace with your Deriv API token
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const TELEGRAM_BOT_TOKEN = '7834723053:AAE3oqsuPQyo5rqTOsHL_pwnF2zyN-Qv1GI';
const WHITEHAT_CHAT_ID = '1889378485'

const app = express();
app.use(bodyParser.json());

const trades = new Map(); // Track each trade by its symbol or unique ID

let ws; // WebSocket instance
const PING_INTERVAL = 30000; // Send a ping every 30 seconds
let pingInterval; // Store the interval ID

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
const placeTrade = async (ws, trade) => {
  const { symbol, call, stake } = trade;

  const contractType = call === 'call' ? 'CALL' : 'PUT';

  try {
    // Send the message to Telegram
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: WHITEHAT_CHAT_ID,
      text: `Placing trade for ${symbol} - Martingale Step: ${trade.martingaleStep}, Stake: ${stake}`,
    });
    console.log(`Telegram alert sent: Placing trade for ${symbol} - Stake: ${stake}`);
  } catch (err) {
    console.error(`Error sending Telegram alert: ${err.message}`);
  }

  console.log(`Placing trade for ${symbol} - Martingale Step: ${trade.martingaleStep}, Stake: ${stake}`);
  sendToWebSocket(ws, {
    buy: 1,
    price: stake,
    parameters: {
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      duration: trade.duration,
      duration_unit: 'm',
      symbol: 'frx' + symbol,
    },
  });
};


// Function to handle trade results
const handleTradeResult = async (trade, contract) => {
  const { symbol } = trade;

  try {
    // Send trade result to Telegram
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: WHITEHAT_CHAT_ID,
      text: `Trade completed for ${symbol}: ${JSON.stringify(contract)}`,
    });
    console.log(`Telegram alert sent: Trade completed for ${symbol}`);
  } catch (err) {
    console.error(`Error sending Telegram alert: ${err.message}`);
  }

  if (contract.status === 'sold') {
    const tradePnL = contract.profit;
    trade.totalPnL += tradePnL;

    if (tradePnL > 0) {
      console.log(`Trade for ${symbol} won. PnL: ${tradePnL.toFixed(2)} USD.`);
      trades.delete(symbol); // Stop tracking this trade
    } else {
      trade.martingaleStep++;
      if (trade.martingaleStep <= trade.maxMartingaleSteps) {
        trade.stake *= 2; // Double the stake
        console.log(
          `Trade for ${symbol} lost. Entering Martingale step ${trade.martingaleStep} with stake ${trade.stake} USD.`
        );
        placeTrade(ws, trade); // Place the next trade in the sequence
      } else {
        console.log(
          `All Martingale steps for ${symbol} lost. Total PnL: ${trade.totalPnL.toFixed(
            2
          )} USD. Returning to idle state.`
        );
        trades.delete(symbol); // Stop tracking this trade
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

    // Start sending periodic pings
    clearInterval(pingInterval); // Clear any existing intervals
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ping: 1 }));
      }
    }, PING_INTERVAL);
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

      if (contract.is_expired) {
        const symbol = contract.underlying.slice(3); // Extract symbol from "frxUSDJPY"

        if (trades.has(symbol)) {
          console.log(`Trade completed for ${symbol}. Processing result...`);
          handleTradeResult(trades.get(symbol), contract);
        } else {
          console.warn(`Received trade result for unknown symbol: ${symbol}`);
        }
      }
    }

    if (response.msg_type === 'error') {
      console.error('Error:', response.error.message);
    }
  });

  ws.on('close', () => {
    console.error('WebSocket connection closed. Reconnecting in 5 seconds...');
    clearInterval(pingInterval); // Stop pinging when the connection is closed
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
