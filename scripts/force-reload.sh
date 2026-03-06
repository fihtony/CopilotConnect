#!/bin/bash
# Force reload VS Code extension

echo "🔍 Checking current running version..."
CURRENT_VERSION=$(curl -s http://localhost:1288/health 2>/dev/null | python3 -c "import sys, json; print(json.load(sys.stdin).get('version', 'not running'))" 2>/dev/null || echo "not running")
echo "Current version: $CURRENT_VERSION"

if [ "$CURRENT_VERSION" != "not running" ]; then
    echo ""
    echo "⚠️  Bridge is running. You need to:"
    echo "   1. Click status bar → Stop Bridge"
    echo "   2. Close this terminal"
    echo "   3. In VS Code: Cmd+Shift+P → 'Developer: Reload Window'"
    echo "   4. After reload, run: ./check-session.sh"
    echo ""
    echo "🔍 Checking installed extensions..."
    ls -la ~/.vscode/extensions/ | grep mybridge
    echo ""
    echo "📝 Latest installed: 0.0.4"
    echo ""
    read -p "Press ENTER to continue after you've stopped the bridge and reloaded VS Code..."
fi

echo ""
echo "🔍 Verifying installation..."
if [ ! -d ~/.vscode/extensions/undefined_publisher.mybridge-0.0.4 ]; then
    echo "❌ Version 0.0.4 not installed!"
    echo "Please install mybridge-0.0.4.vsix first"
    exit 1
fi

echo "✅ Version 0.0.4 is installed"
echo ""
echo "🔍 Checking if extension code has modelId..."
if grep -q "modelId: s.modelId" ~/.vscode/extensions/undefined_publisher.mybridge-0.0.4/dist/server.js; then
    echo "✅ Installed code contains modelId"
else
    echo "❌ Installed code is missing modelId"
    echo "Please reinstall the VSIX"
    exit 1
fi

echo ""
echo "🔍 Waiting for bridge to start..."
for i in {1..10}; do
    if curl -s http://localhost:1288/health > /dev/null 2>&1; then
        echo "✅ Bridge is running"
        break
    fi
    echo "Waiting... ($i/10)"
    sleep 1
done

echo ""
echo "🧪 Running check..."
./check-session.sh
