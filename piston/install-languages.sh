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
install_lang "python"
install_lang "javascript"
install_lang "typescript"
install_lang "java"
install_lang "c"
install_lang "c++"
install_lang "go"
install_lang "rust"
install_lang "ruby"
install_lang "php"
install_lang "bash"
install_lang "lua"
install_lang "perl"
install_lang "kotlin"
install_lang "scala"
install_lang "swift"
install_lang "haskell"
install_lang "csharp"
install_lang "sqlite3"

echo ""
echo "Installation complete!"
echo "Installed runtimes:"
curl -s "$PISTON_URL/api/v2/runtimes" | grep -o '"language":"[^"]*"' | sort -u
