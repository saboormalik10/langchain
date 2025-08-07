#!/bin/bash

# Test script for SQL Agent + Azure OpenAI integration
echo "🧪 Testing SQL Agent + Azure OpenAI Hybrid Approach"
echo "=============================================="

# Test 1: Query that might have column name issues
echo "📋 Test 1: Testing query with potential column name conflicts..."
curl -X POST http://localhost:3001/api/medical \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "test_org_001",
    "query": "show me all medications for patients with diabetes",
    "databaseType": "mysql",
    "databaseVersion": "8.0.33",
    "generateGraph": false,
    "useChains": false
  }' | jq '.'

echo ""
echo "=============================================="

# Test 2: More complex query that should benefit from schema validation
echo "📋 Test 2: Testing complex query requiring schema validation..."
curl -X POST http://localhost:3001/api/medical \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "test_org_001", 
    "query": "get patient medication history with lab results",
    "databaseType": "mysql",
    "databaseVersion": "8.0.33",
    "generateGraph": false,
    "useChains": false
  }' | jq '.'

echo ""
echo "✅ Test completed!"
