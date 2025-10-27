THIS_DIR := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))
BIN_DIR := $(THIS_DIR)/bin
TMP_DIR := $(THIS_DIR)/tmp

# Allow override via environment: RG_VERSION=15.0.0 make download-ripgrep
RG_VERSION ?= 15.0.0

# Detect OS and Architecture
ifeq ($(OS),Windows_NT)
  # Windows environment
  ARCH := $(shell powershell -Command "if ([System.Environment]::Is64BitOperatingSystem) { 'x86_64' } else { 'x86' }")
  OS := Windows
else
  # Unix-like systems (Linux, macOS, etc.)
  OS := $(shell uname -s)
  ARCH := $(shell uname -m)
endif

# Map OS/ARCH to ripgrep TARGET name
# See: https://github.com/BurntSushi/ripgrep/releases
ifeq ($(OS),Darwin)
  ifeq ($(ARCH),arm64)
    RG_TARGET := aarch64-apple-darwin
  else ifeq ($(ARCH),x86_64)
    RG_TARGET := x86_64-apple-darwin
  else
    $(error Unsupported macOS architecture: $(ARCH))
  endif
else ifeq ($(OS),Linux)
  ifeq ($(ARCH),x86_64)
    RG_TARGET := x86_64-unknown-linux-musl
  else ifeq ($(ARCH),aarch64)
    RG_TARGET := aarch64-unknown-linux-gnu
  else ifeq ($(ARCH),armv7l)
    RG_TARGET := arm-unknown-linux-gnueabihf
  else
    $(error Unsupported Linux architecture: $(ARCH))
  endif
else ifeq ($(OS),Windows)
  ifeq ($(ARCH),x86_64)
    RG_TARGET := x86_64-pc-windows-msvc
    RG_EXT := zip
  else
    $(error Unsupported Windows architecture: $(ARCH))
  endif
else
  $(error Unsupported OS: $(OS))
endif

# Set default extension for non-Windows platforms
RG_EXT ?= tar.gz

RG_URL := https://github.com/BurntSushi/ripgrep/releases/download/$(RG_VERSION)/ripgrep-$(RG_VERSION)-$(RG_TARGET).$(RG_EXT)
RG_ARCHIVE := ripgrep-$(RG_VERSION)-$(RG_TARGET).$(RG_EXT)


.PHONY: download-ripgrep
download-ripgrep:
	@echo "Downloading ripgrep $(RG_VERSION) for $(OS) $(ARCH)..."
ifeq ($(OS),Windows)
	@powershell -Command "if (Test-Path '$(BIN_DIR)/rg.exe') { Write-Host 'rg already installed at $(BIN_DIR)/rg.exe' } else { Write-Host 'Downloading ripgrep $(RG_VERSION) from: $(RG_URL)'; if (!(Test-Path '$(BIN_DIR)')) { New-Item -ItemType Directory -Path '$(BIN_DIR)' -Force | Out-Null }; if (!(Test-Path '$(TMP_DIR)')) { New-Item -ItemType Directory -Path '$(TMP_DIR)' -Force | Out-Null }; Invoke-WebRequest -Uri '$(RG_URL)' -OutFile '$(TMP_DIR)/$(RG_ARCHIVE)'; Expand-Archive -Path '$(TMP_DIR)/$(RG_ARCHIVE)' -DestinationPath '$(TMP_DIR)' -Force; Copy-Item '$(TMP_DIR)/ripgrep-$(RG_VERSION)-$(RG_TARGET)/rg.exe' '$(BIN_DIR)/rg.exe'; Write-Host 'rg installed at $(BIN_DIR)/rg.exe' }"
else
	@if [ -f "$(BIN_DIR)/rg" ]; then \
		echo "rg already installed at $(BIN_DIR)/rg"; \
	else \
		echo "Downloading ripgrep $(RG_VERSION) from: $(RG_URL)"; \
		mkdir -p "$(BIN_DIR)" "$(TMP_DIR)"; \
		if command -v curl >/dev/null 2>&1; then \
			curl -L --fail -o "$(TMP_DIR)/$(RG_ARCHIVE)" "$(RG_URL)"; \
		else \
			if command -v wget >/dev/null 2>&1; then \
				wget -O "$(TMP_DIR)/$(RG_ARCHIVE)" "$(RG_URL)"; \
			else \
				echo "Error: neither curl nor wget is available" && exit 1; \
			fi; \
		fi; \
		tar -xzf "$(TMP_DIR)/$(RG_ARCHIVE)" -C "$(TMP_DIR)"; \
		cp "$(TMP_DIR)/ripgrep-$(RG_VERSION)-$(RG_TARGET)/rg" "$(BIN_DIR)/rg"; \
		chmod +x "$(BIN_DIR)/rg"; \
		echo "rg installed at $(BIN_DIR)/rg"; \
	fi
endif


.PHONY: download-deps
download-deps: download-ripgrep
