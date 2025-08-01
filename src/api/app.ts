#!/usr/bin/env node

import * as dotenv from 'dotenv';
import { MedicalLangChainAPI } from './server';

// Load environment variables
dotenv.config();

// Start the API servers
const api = new MedicalLangChainAPI();
api.start().catch((error: any) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
