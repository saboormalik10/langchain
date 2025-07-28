#!/usr/bin/env node

import { MedicalLangChainAPI } from './server';

// Start the API server
const api = new MedicalLangChainAPI();
api.start().catch((error: any) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
