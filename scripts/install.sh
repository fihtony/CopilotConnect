#!/bin/bash

echo "================================================"
echo "  Copilot Connect (Copilot信使) Installer"
echo "================================================"
echo ""
echo "Installing version 1.0.0..."
echo ""

# Check if VSIX exists
if [ ! -f "copilot-connect-1.0.0.vsix" ]; then
    echo "❌ Error: copilot-connect-1.0.0.vsix not found"
    echo "Please run 'npm run package' first"
    exit 1
fi

echo "📦 VSIX file found: copilot-connect-1.0.0.vsix"
echo ""
echo "Installation steps:"
echo "1. In VS Code, press Cmd+Shift+P (macOS) or Ctrl+Shift+P (Windows/Linux)"
echo "2. Type 'Extensions: Install from VSIX...'"
echo "3. Select: $(pwd)/copilot-connect-1.0.0.vsix"
echo "4. After installation, reload VS Code window"
echo ""
echo "Or simply drag and drop the VSIX file into VS Code"
echo ""

# Try to open with VS Code if available
if command -v code &> /dev/null; then
    echo "Opening VSIX file with VS Code..."
    code --install-extension copilot-connect-1.0.0.vsix
    echo ""
    echo "✅ Installation initiated!"
    echo ""
    echo "Next steps:"
    echo "1. Reload VS Code window (Cmd+Shift+P → 'Developer: Reload Window')"
    echo "2. Look for the status bar item: $(radio-tower) Connect: Running :1288"
    echo "3. Click it to open the menu"
else
    echo "VS Code CLI not found. Please install manually via VS Code UI."
    open -a "Visual Studio Code" copilot-connect-1.0.0.vsix 2>/dev/null
fi

echo ""
echo "================================================"
echo "  For help, see README.md"
echo "================================================"
