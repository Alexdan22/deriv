const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');  // Import UUID package

require('dotenv').config(); // Load environment variables from .env file

const API_TOKENS = process.env.API_TOKENS.split(',');
const WEBSOCKET_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

const app = express();
app.use(bodyParser.json());

const accountTrades = new Map();
const zone = new Map();      // Track per-account zone
const condition = new Map(); // Track per-account condition
const confirmation = new Map(); // Track per-account confirmation


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
  // Guard clause: Validate required properties
  if (!contract || !accountId || !contract.profit) return;

  // Get trades for this account
  const tradesForAccount = accountTrades.get(accountId);
  if (!tradesForAccount) return;

  // Extract trade ID from echo_req
  const tradeId = contract.echo_req?.custom_trade_id?.split('_')[1];
  if (!tradeId) return;

  const trade = tradesForAccount.get(tradeId);
  if (!trade) return;

  if (contract.is_expired || contract.is_sold) {
    if (contract.profit < 0) {
      if (trade.martingaleStep < trade.maxMartingaleSteps) {
        const newStake = trade.stake * 2;
        const ws = wsConnections.find(conn => conn.accountId === accountId);
        await placeTrade(ws, accountId, { ...trade, stake: newStake });
        trade.martingaleStep++;
        tradesForAccount.set(tradeId, trade);
      } else {
        tradesForAccount.delete(tradeId);
      }
    } else {
      tradesForAccount.delete(tradeId);
    }
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
          if (!response.echo_req?.custom_trade_id) return;
          const [accountId, tradeId] = response.echo_req.custom_trade_id.split('_');
          if (!response.buy || !response.buy.contract_id) {
              // console.log('Invalid buy response:', response);
              return;
          }
      
          const contractId = response.buy.contract_id;
      
          if (!tradeId || !trades.has(tradeId)) {
              console.log(`Trade ID not found for contract ${contractId}`);
              return;
          }
      
          const trade = trades.get(tradeId);
          trade.lastContractId = contractId;  // Store contract ID
          trades.set(tradeId, trade);
      
          console.log(`Trade tracked: ${tradeId} (Account: ${trade.accountId}) -> Contract ${contractId}`);
      }
      
      
              // In the WebSocket message handler:
        if (response.msg_type === 'proposal_open_contract') {
          const contract = response.proposal_open_contract;
          
          // Add null checks:
          if (!contract || !contract.echo_req?.custom_trade_id) return;

          const tradeIdParts = contract.echo_req.custom_trade_id.split('_');
          if (tradeIdParts.length !== 2) return; // Validate format

          if ( contract.status !== 'open') {
            const [accountId, tradeId] = tradeIdParts;
            handleTradeResult(contract, accountId); // Pass accountId explicitly
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
  API_TOKENS.forEach((accountId) => {
    // Initialize account-specific state if missing
    if (!zone.has(accountId)) zone.set(accountId, null);
    if (!condition.has(accountId)) condition.set(accountId, null);
    if (!confirmation.has(accountId)) confirmation.set(accountId, null);

    // Update state based on message
    switch (message) {
      case 'ZONE':
        zone.set(accountId, call);
        break;
      case 'CONDITION':
        condition.set(accountId, call);
        break;
      case 'CONFIRMATION':
        confirmation.set(accountId, call);
        break;
    }

    // Check if all conditions are met for this account
    if (
      zone.get(accountId) === call &&
      condition.get(accountId) === call &&
      confirmation.get(accountId) === call
    ) {
      const ws = wsConnections.find(conn => conn.accountId === accountId);
      if (ws) {
        placeTrade(ws, accountId, { 
          symbol: 'frxXAUUSD', 
          call, 
          stake: 10 
        });
        // Reset conditions for this account
        condition.set(accountId, null);
        confirmation.set(accountId, null);
      }
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
