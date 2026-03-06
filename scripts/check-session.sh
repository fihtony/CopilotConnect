#!/bin/bash
# Check if session endpoint returns modelId

echo "Checking bridge version..."
curl -s http://localhost:1288/health | python3 -m json.tool
echo ""

echo "Creating a test session..."
SESSION_ID=$(curl -s -X POST http://localhost:1288/session/create | python3 -c "import sys, json; print(json.load(sys.stdin)['sessionId'])")

echo "Session ID: $SESSION_ID"
echo ""
echo "Checking session info..."
curl -s http://localhost:1288/session/$SESSION_ID | python3 -m json.tool

echo ""
echo "Checking if modelId field exists..."
HAS_MODEL_ID=$(curl -s http://localhost:1288/session/$SESSION_ID | python3 -c "import sys, json; data = json.load(sys.stdin); print('YES' if 'modelId' in data.get('session', {}) else 'NO')")

if [ "$HAS_MODEL_ID" = "YES" ]; then
    echo "✅ SUCCESS: modelId field is present"
    exit 0
else
    echo "❌ FAILED: modelId field is missing"
    echo ""
    echo "This means you're running an old version of the extension."
    echo "Please:"
    echo "  1. Stop the bridge (click status bar → Stop Bridge)"
    echo "  2. Reload VS Code window (Cmd+Shift+P → 'Developer: Reload Window')"
    echo "  3. Check status bar shows version 0.0.3 or later"
    echo "  4. Run this script again"
    exit 1
fi
