const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const API_TOKENS = [
  'VX41WSwVGQDET3r',
  'Iah2zoaMjIVRvq9', // Replace with your actual API tokens
  '44TRhSy7NFXLsSl'
];
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const trades = new Map(); // Track each trade by its symbol or unique ID

let zone = null;   //First level condition for Trend confirmation
let condition = null;  // Second level condition for Entry alert
let confirmation = null; // Final level condition for Entering Trade position 

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
  const { symbol, call, stake } = trade;
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
        duration: 5,
        duration_unit: 'm',
        symbol: symbol,
      },
    });
    console.log(`Trade placed: ${symbol}, ${contractType}, Stake: ${stake}`);
  } catch (error) {
    console.error(`Error placing trade for ${symbol}:, error`);
  }
};

// Function to handle trade results
const handleTradeResult = async (contract) => {

  console.log(`Processing trade result for ${contract.underlying}`);
  const tradeKey = `frxXAUUSD-${contract.underlying}`;

  if (contract.is_expired || contract.is_sold) {
    const tradePnL = contract.profit;

    if (tradePnL > 0) {
      console.log(`Trade for ${contract.underlying} won. PnL: ${tradePnL} USD.`);
    } else {
      //Enter martingale step
      const trade = trades.has(tradeKey);
      trade.martingaleStep++;
      if (trade.martingaleStep <= trade.maxMartingaleSteps) {
        trade.stake *= 2; // Double the stake
        console.log(
          `Trade for ${trade.symbol} lost. Entering Martingale step ${trade.martingaleStep} with stake ${trade.stake} USD.`
        );
        placeTrade(ws, trade); // Place the next trade in the sequence
      } else {
        console.log(
          `All Martingale steps for ${trade.symbol} lost. Total PnL: ${trade.totalPnL}USD. Returning to idle state.`
        );
        trades.delete(tradeKey); // Stop tracking this trade
      }

    }
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
        sendToWebSocket(ws, { proposal_open_contract: 1, subscribe: 1 });
      }, PING_INTERVAL);
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data);
        //Map the new trade to the Trade map
      if(response.msg_type === 'buy'){
        const buy = response.buy;
        const tradeKey = `frxXAUUSD-${buy.contract_id}`
        if(!trades.has(tradeKey)){
          const trade = {
            symbol: 'frxXAUUSD',
            call: buy.call,
            stake: buy.stake, // Initial stake
            martingaleStep: 0,
            maxMartingaleSteps: 1,
            totalPnL: 0,
          };
        
          trades.set(tradeKey, trade);
    
          trades.set(tradeKey, trade); // Add the unique key
          console.log('Updated trades map:', Array.from(trades.keys()));
        } 
      }  

        // Handle 'proposal_open_contract' response
      if (response.msg_type === 'proposal_open_contract') {
        const contract = response.proposal_open_contract;
      
        if (!contract || !contract.underlying || !contract.contract_id) {
          return;
        }
        
        if ( contract.status !== 'open') {
          handleTradeResult(contract);
        }
      }

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
  const { symbol, call, message } = req.body;

  if (!symbol || !call || message) {
    console.error('Invalid webhook payload:', req.body);
    return res.status(400).send('Invalid webhook payload');
  }

  const normalizedSymbol = 'frx' + symbol; // Normalize symbol
  console.log(`Webhook received for symbol: ${normalizedSymbol}, call: ${call}`);

  const trade = {
    symbol: normalizedSymbol,
    call,
    stake: 10, // Initial stake
    martingaleStep: 0,
    maxMartingaleSteps: 1,
    totalPnL: 0,
  };

  if(message === 'ZONE'){
    zone = call;
    if(condition == 'call' && confirmation == 'call' && zone == 'call' ){
      //Enter trade for call
      try {
        // Place the trade on all accounts
        wsConnections.forEach((ws) => {
          placeTrade(ws, trade);
        });
        //Reset the conditions and confirmation
        condition = null;
        confirmation = null;
      } catch (error) {
        console.error('Error processing alert:', error);
      }
    }else if(condition == 'put' && confirmation == 'put' && zone == 'put'){
       //Enter trade for call
      try {
        // Place the trade on all accounts
        wsConnections.forEach((ws) => {
          placeTrade(ws, trade);
        });
        //Reset the conditions and confirmation
        condition = null;
        confirmation = null;
      } catch (error) {
        console.error('Error processing alert:', error);
      }
    }else{

      return;
    
    }
  }
  if(message === 'CONDITION'){
    condition = call;
    if(condition == 'call' && confirmation == 'call' && zone == 'call' ){
      //Enter trade for call
      try {
        // Place the trade on all accounts
        wsConnections.forEach((ws) => {
          placeTrade(ws, trade);
        });
        //Reset the conditions and confirmation
        condition = null;
        confirmation = null;
      } catch (error) {
        console.error('Error processing alert:', error);
      }
    }else if(condition == 'put' && confirmation == 'put' && zone == 'put'){
       //Enter trade for call
      try {
        // Place the trade on all accounts
        wsConnections.forEach((ws) => {
          placeTrade(ws, trade);
        });
        //Reset the conditions and confirmation
        condition = null;
        confirmation = null;
      } catch (error) {
        console.error('Error processing alert:', error);
      }
    }else{

      return;
    
    }
  }
  if(message === 'ZONE'){
    zone = call;
    if(condition == 'call' && confirmation == 'call' && zone == 'call' ){
      //Enter trade for call
      try {
        // Place the trade on all accounts
        wsConnections.forEach((ws) => {
          placeTrade(ws, trade);
        });
        //Reset the conditions and confirmation
        condition = null;
        confirmation = null;
      } catch (error) {
        console.error('Error processing alert:', error);
      }
    }else if(condition == 'put' && confirmation == 'put' && zone == 'put'){
       //Enter trade for call
      try {
        // Place the trade on all accounts
        wsConnections.forEach((ws) => {
          placeTrade(ws, trade);
        });
        //Reset the conditions and confirmation
        condition = null;
        confirmation = null;
      } catch (error) {
        console.error('Error processing alert:', error);
      }
    }else{

      return;
    
    }
  }

 

});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`TradingView webhook listener running on port ${PORT}`);
});

// Start WebSocket connections
createWebSocketConnections();