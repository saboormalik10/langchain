#!/bin/bash

# Test file upload
echo "Testing file upload endpoint..."
curl -X POST http://localhost:3000/api/files/upload \
  -F "file=@./uploads/test_patients.csv" \
  -F "tableName=patients" \
  -F "updateExisting=true" \
  -F "skipErrors=true"

echo -e "\n\n"

# Test mappings endpoint
echo "Testing mappings endpoint..."
curl -X POST http://localhost:3000/api/files/mappings \
  -F "file=@./uploads/test_patients.csv"

echo -e "\n\n"
echo "Done!"
