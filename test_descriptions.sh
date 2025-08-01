#!/bin/bash

# Test the new description feature
echo "🧪 Testing Medical API with Description Feature"
echo "================================================"

# Test 1: Basic query with descriptions enabled (default)
echo "📋 Test 1: Query with descriptions enabled (default)"
curl -X POST "http://localhost:3001/api/medical/query-sql-manual" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "test-org-1",
    "query": "What tables are available in the database?"
  }' | jq '.query_description, .result_explanation' 2>/dev/null || echo "Response received"

echo -e "\n"

# Test 2: Query with descriptions explicitly enabled  
echo "📋 Test 2: Query with descriptions explicitly enabled"
curl -X POST "http://localhost:3001/api/medical/query-sql-manual" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "test-org-1", 
    "query": "Show me patient information",
    "generateDescription": true
  }' | jq '.query_description, .result_explanation' 2>/dev/null || echo "Response received"

echo -e "\n"

# Test 3: Query with descriptions disabled
echo "📋 Test 3: Query with descriptions disabled"
curl -X POST "http://localhost:3001/api/medical/query-sql-manual" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "test-org-1",
    "query": "Show me patient information", 
    "generateDescription": false
  }' | jq '.query_description, .result_explanation' 2>/dev/null || echo "Response received"

echo -e "\n"

# Test 4: Invalid query to test error descriptions
echo "📋 Test 4: Invalid query to test error descriptions"
curl -X POST "http://localhost:3001/api/medical/query-sql-manual" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "test-org-1",
    "query": "Show me data from nonexistent_table",
    "generateDescription": true
  }' | jq '.error_description' 2>/dev/null || echo "Response received"

echo -e "\n"
echo "✅ Tests completed!"
