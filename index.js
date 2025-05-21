const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

dotenv.config();

const PORT = process.env.PORT || 4000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/ws',
  cors: {
    origin: '*', // Allow any origin for testing
    methods: ['GET', 'POST'],
  },
  transports: ['websocket'], // Force WebSocket transport
});

let tokenHolders = new Map(); // Map to store holders with aggregated balances
let TOKEN_DECIMALS = 6; // Default value, will be updated on startup

// Get token mint address from command line or environment variable
const tokenMintAddress = process.argv[2] || process.env.TOKEN_MINT_ADDRESS;
if (!tokenMintAddress) {
  console.error('Error: Token mint address not provided. Specify as argument or in .env.');
  process.exit(1);
}
console.log(`Using token mint address: ${tokenMintAddress}`);

// WebSocket connection handler
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Send the current state to the new client with token details from config
  socket.emit('initial_data', {
    holders: Array.from(tokenHolders.values()),
    contractAddress: tokenMintAddress // Send CA along with holders
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Periodic update with full fetch and incremental broadcast
async function updateTokenHolders() {
  await findHolders();
}

// Function to fetch token decimals
async function fetchTokenDecimals() {
  try {
    const response = await fetch(process.env.HELIUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'helius-fetch-decimals',
        method: 'getAsset',
        params: {
          id: tokenMintAddress,
        },
      }),
    });
    const data = await response.json();
    if (data.result && data.result.token_info && typeof data.result.token_info.decimals === 'number') {
      TOKEN_DECIMALS = data.result.token_info.decimals;
      console.log(`Successfully fetched token decimals: ${TOKEN_DECIMALS}`);
    } else {
      console.error('Failed to fetch token decimals, using default:', TOKEN_DECIMALS, data);
    }
  } catch (error) {
    console.error('Error fetching token decimals:', error);
    console.log('Using default token decimals:', TOKEN_DECIMALS);
  }
}

// Set up the periodic fetch
setInterval(() => updateTokenHolders(), 60000); // Every minute

// Initial fetch to populate holders on startup and fetch decimals
async function initialize() {
  await fetchTokenDecimals();
  await updateTokenHolders();
}

initialize();

// Fetch holders using Helius RPC with pagination
async function findHolders() {
  let page = 1;
  const newHolders = new Map();

  while (true) {
    const response = await fetch(process.env.HELIUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'getTokenAccounts',
        id: 'helius-fetch',
        params: {
          page: page,
          limit: 1000,
          displayOptions: {},
          mint: tokenMintAddress,
        },
      }),
    });

    const data = await response.json();
    if (!data.result || data.result.token_accounts.length === 0) {
      console.log(
        `No more results after page ${page - 1}. Total holders processed: ${newHolders.size}`
      );
      break;
    }

    console.log(`Processing results from page ${page}`);
    data.result.token_accounts.forEach((account) => {
      const owner = account.owner;
      const amount = parseInt(account.amount, 10);
      const balance = parseFloat((amount / Math.pow(10, TOKEN_DECIMALS)).toFixed(TOKEN_DECIMALS));

      if (newHolders.has(owner)) {
        // Aggregate balance for the owner
        const existingHolder = newHolders.get(owner);
        existingHolder.balance += balance;
        newHolders.set(owner, existingHolder);
      } else {
        newHolders.set(owner, {
          address: owner,
          balance: balance,
        });
      }
    });

    page++;
  }

  console.log('Total unique holders after aggregation:', newHolders.size);

  processTokenHolderUpdates(newHolders);
}

// Compare and send incremental updates
function processTokenHolderUpdates(newHolders) {
  const added = [];
  const updated = [];
  const removed = [];

  console.log(newHolders.size);
  console.log(tokenHolders.size);
  
  // Check for pagination issues
  if ((newHolders.size / tokenHolders.size) < 0.95 && tokenHolders.size > 1000) {
    console.error("Pagination issue detected.");
    return
  }

  // Check for added or updated holders
  newHolders.forEach((newHolder, address) => {
    const oldHolder = tokenHolders.get(address);
    if (!oldHolder) {
      added.push(newHolder); // New holder
    } else if (oldHolder.balance !== newHolder.balance) {
      updated.push(newHolder); // Balance change
    }
  });

  // Check for removed holders
  tokenHolders.forEach((_, address) => {
    if (!newHolders.has(address)) {
      removed.push({ address });
    }
  });

  // Update the main tokenHolders map
  tokenHolders = newHolders;

  // Send only the changes to clients
  if (added.length || updated.length || removed.length) {
    io.emit('update', { added, updated, removed });
    console.log('Updates sent to clients:', {
      addedCount: added.length,
      updatedCount: updated.length,
      removedCount: removed.length,
    });
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
