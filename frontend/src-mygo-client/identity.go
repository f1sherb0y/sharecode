package main

// build-windows.ps1 -Release links the released client's identity in with -X.
// Every other build is a development client with its own name, install
// directory and WebView2 profile, so it never touches a real installation.
var (
	applicationID      = "dev.sharecode.client.mygo-dev"
	applicationName    = "sharecode-client-mygo-dev"
	applicationVersion = "0.2.8"
)

const productionID = "dev.sharecode.client"
