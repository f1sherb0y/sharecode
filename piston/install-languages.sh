#!/bin/bash
# Install common programming languages for Piston

set -e

echo "Installing language runtimes..."

# Wait for API to be ready
sleep 5

CLI="/piston/cli/index.js"

# Core languages
$CLI ppman install python
$CLI ppman install javascript
$CLI ppman install typescript
$CLI ppman install java
$CLI ppman install c
$CLI ppman install c++
$CLI ppman install go
$CLI ppman install rust
$CLI ppman install ruby
$CLI ppman install php
$CLI ppman install bash
$CLI ppman install lua
$CLI ppman install perl
$CLI ppman install swift
$CLI ppman install kotlin
$CLI ppman install scala
$CLI ppman install csharp
$CLI ppman install haskell
$CLI ppman install r

echo "Language installation complete!"
