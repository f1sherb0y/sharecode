#!/bin/bash
# Install language runtimes in Piston via API
# Usage: ./install-languages.sh [PISTON_URL]

PISTON_URL="${1:-http://localhost:2000}"

echo "Installing languages to Piston at $PISTON_URL"
echo "This may take several minutes..."

install_lang() {
    local lang=$1
    echo -n "Installing $lang... "
    result=$(curl -s -X POST "$PISTON_URL/api/v2/packages" \
        -H "Content-Type: application/json" \
        -d "{\"language\": \"$lang\", \"version\": \"*\"}" 2>&1)

    if echo "$result" | grep -q '"language"'; then
        echo "OK"
    else
        echo "FAILED: $result"
    fi
}

# Wait for API to be ready
echo "Waiting for Piston API..."
for i in {1..30}; do
    if curl -s "$PISTON_URL/api/v2/runtimes" > /dev/null 2>&1; then
        echo "API is ready!"
        break
    fi
    sleep 2
done

# Install common languages
# Note: Package names differ from language names in some cases
install_lang "python"       # python
install_lang "node"         # javascript/node.js
install_lang "typescript"   # typescript
install_lang "java"         # java
install_lang "gcc"          # c and c++
install_lang "go"           # go
install_lang "rust"         # rust
install_lang "ruby"         # ruby
install_lang "php"          # php
install_lang "bash"         # bash
install_lang "lua"          # lua
install_lang "perl"         # perl
install_lang "kotlin"       # kotlin
install_lang "scala"        # scala
install_lang "swift"        # swift
install_lang "haskell"      # haskell
install_lang "mono"         # c# (csharp)
install_lang "sqlite3"      # sqlite3

echo ""
echo "Installation complete!"
echo "Installed runtimes:"
curl -s "$PISTON_URL/api/v2/runtimes" | grep -o '"language":"[^"]*"' | sort -u
