const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

require('dotenv').config(); // Load environment variables from .env file

const API_TOKENS = process.env.API_TOKENS.split(',');
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const accountTrades = new Map();
let zone = null, condition = null, confirmation = null;

const PING_INTERVAL = 30000;
let wsConnections = [];

const sendToWebSocket = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
};

const parseDuration = (duration) => {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);
  return unit === 't' ? value : unit === 's' ? value / 60 : unit === 'm' ? value : unit === 'h' ? value * 60 : unit === 'd' ? value * 1440 : Infinity;
};

const { v4: uuidv4 } = require('uuid');  // Import UUID package

// const placeTrade = async (ws, trade, accountId) => {
//     // if (await hasReachedProfitLimit(accountId)) {
//     //     console.log(`Account ${accountId} has reached daily profit limit. Ignoring trade.`);
//     //     return;
//     // }

//     const tradeId = uuidv4();  // Generate a unique trade ID
//     trade.uniqueId = tradeId;  // Attach trade ID

//     // Store trade details in the map
//     trades.set(tradeId, {
//         accountId,  // Store accountId for tracking
//         symbol: trade.symbol,
//         call: trade.call,
//         stake: trade.stake,
//         martingaleStep: 0,
//         maxMartingaleSteps: 2,  // Example max steps
//         lastContractId: null
//     });

//     sendToWebSocket(ws, {
//         buy: 1,
//         price: trade.stake,
//         parameters: {
//             amount: trade.stake,
//             basis: 'stake',
//             contract_type: trade.call === 'call' ? 'CALL' : 'PUT',
//             currency: 'USD',
//             duration: 5,
//             duration_unit: 'm',
//             symbol: trade.symbol,
//         },
//         custom_trade_id: tradeId  // Send trade ID to track it later
//     });

//     console.log(`Trade placed: ${tradeId} for account ${accountId}`);
// };

const placeTrade = async (ws, accountId, trade) => { // Add accountId parameter
  const tradeId = uuidv4();
  
  // Initialize account-specific trades if needed
  if (!accountTrades.has(accountId)) {
      accountTrades.set(accountId, new Map());
  }
  
  const tradesForAccount = accountTrades.get(accountId);
  tradesForAccount.set(tradeId, {
      symbol: trade.symbol,
      call: trade.call,
      stake: trade.stake,
      martingaleStep: 0,
      maxMartingaleSteps: 2,
      lastContractId: null
  });

  sendToWebSocket(ws, {
      buy: 1,
      price: trade.stake,
      parameters: {
        amount: trade.stake,
        basis: 'stake',
        contract_type: trade.call === 'call' ? 'CALL' : 'PUT',
        currency: 'USD',
        duration: 5,
        duration_unit: 'm',
        symbol: trade.symbol,
      },
      custom_trade_id: `${accountId}_${tradeId}` // Embed accountId in trade ID
  });
};



const handleTradeResult = async (contract, accountId) => {
  const tradeId = contract.echo_req.custom_trade_id.split('_')[1]; // Extract tradeId
  const tradesForAccount = accountTrades.get(accountId);
  const trade = tradesForAccount.get(tradeId);

  if (contract.profit < 0 && trade.martingaleStep < trade.maxMartingaleSteps) {
      // Execute Martingale ONLY for this account
      const newStake = trade.stake * 2;
      const ws = wsConnections.find(conn => conn.accountId === accountId);
      placeTrade(ws, accountId, { ...trade, stake: newStake });
  } else {
      tradesForAccount.delete(tradeId); // Cleanup
  }
};


const createWebSocketConnections = () => {
  wsConnections.forEach(ws => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });
  
  wsConnections = API_TOKENS.map((apiToken) => {
    const ws = new WebSocket(WEBSOCKET_URL);
    ws.accountId = apiToken; // Attach accountId to WebSocket object

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
        if (response.msg_type === 'buy') {
          if (!response.buy || !response.buy.contract_id) {
              // console.log('Invalid buy response:', response);
              return;
          }
      
          const contractId = response.buy.contract_id;
          const tradeId = response.echo_req?.custom_trade_id;  // Get trade ID
      
          if (!tradeId || !trades.has(tradeId)) {
              console.log(`Trade ID not found for contract ${contractId}`);
              return;
          }
      
          const trade = trades.get(tradeId);
          trade.lastContractId = contractId;  // Store contract ID
          trades.set(tradeId, trade);
      
          console.log(`Trade tracked: ${tradeId} (Account: ${trade.accountId}) -> Contract ${contractId}`);
      }
      
      
      if (response.msg_type === 'proposal_open_contract') {
        const contract = response.proposal_open_contract;
        if (!contract || !contract.underlying || !contract.contract_id) {
          return;
        }
        
        if ( contract.status !== 'open') {
          handleTradeResult(contract);
        }
      }
    });
    
    ws.on('close', () => {
      console.log('WebSocket closed, retrying in 10 seconds...');
      setTimeout(createWebSocketConnections, 10000);
    });
    
    ws.on('error', (error) => console.error('WebSocket error:', error));
    return ws;
  });
};

const processTradeSignal = (message, call) => {
  // Track conditions per account (example logic)
  API_TOKENS.forEach((accountId) => {
      if (!zone.has(accountId)) zone.set(accountId, null);
      if (!condition.has(accountId)) condition.set(accountId, null);
      if (!confirmation.has(accountId)) confirmation.set(accountId, null);

      if (message === 'ZONE') zone.set(accountId, call);
      if (message === 'CONDITION') condition.set(accountId, call);
      if (message === 'CONFIRMATION') confirmation.set(accountId, call);

      if (
          zone.get(accountId) === call &&
          condition.get(accountId) === call &&
          confirmation.get(accountId) === call
      ) {
          const ws = wsConnections.find(conn => conn.accountId === accountId);
          placeTrade(ws, accountId, { symbol: 'frxXAUUSD', call, stake: 10 });
          // Reset conditions for this account
          condition.set(accountId, null);
          confirmation.set(accountId, null);
      }
  });
};

app.post('/webhook', (req, res) => {
  const { symbol, call, message } = req.body;
  if (!symbol || !call || !message) return res.status(400).send('Invalid webhook payload');
  processTradeSignal(message, call);
  res.send('Trade processed');
});

app.listen(3000, () => console.log('Webhook listener running on port 3000'));
createWebSocketConnections();
