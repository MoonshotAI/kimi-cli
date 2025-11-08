THIS_DIR := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))
BIN_DIR := $(THIS_DIR)/bin
TMP_DIR := $(THIS_DIR)/tmp

# Allow override via environment: RG_VERSION=15.0.0 make download-ripgrep
RG_VERSION ?= 15.0.0
OS := $(shell uname -s)
ARCH := $(shell uname -m | tr '[:upper:]' '[:lower:]')
RG_ARCHIVE_EXT := tar.gz
RG_ARCHIVE_BIN := rg
RG_BIN_SUFFIX :=

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
else ifneq (,$(filter MSYS% MINGW%,$(OS)))
  ifeq ($(ARCH),x86_64)
    RG_TARGET := x86_64-pc-windows-msvc
  else ifeq ($(ARCH),aarch64)
    RG_TARGET := aarch64-pc-windows-msvc
  else
    $(error Unsupported Windows architecture: $(ARCH))
  endif
  RG_ARCHIVE_EXT := zip
  RG_ARCHIVE_BIN := rg.exe
  RG_BIN_SUFFIX := .exe
else
  $(error Unsupported OS: $(OS))
endif

RG_ARCHIVE := ripgrep-$(RG_VERSION)-$(RG_TARGET).$(RG_ARCHIVE_EXT)
RG_URL := https://github.com/BurntSushi/ripgrep/releases/download/$(RG_VERSION)/$(RG_ARCHIVE)


.PHONY: download-ripgrep
download-ripgrep:
	@if [ -f "$(BIN_DIR)/rg$(RG_BIN_SUFFIX)" ]; then \
		echo "rg already installed at $(BIN_DIR)/rg$(RG_BIN_SUFFIX)"; \
	else \
		echo "Downloading ripgrep $(RG_VERSION) from: $(RG_URL)"; \
		mkdir -p "$(BIN_DIR)" "$(TMP_DIR)"; \
		ARCHIVE_PATH="$(TMP_DIR)/$(RG_ARCHIVE)"; \
		if command -v curl >/dev/null 2>&1; then \
			curl -L --fail -o "$$ARCHIVE_PATH" "$(RG_URL)"; \
		else \
			if command -v wget >/dev/null 2>&1; then \
				wget -O "$$ARCHIVE_PATH" "$(RG_URL)"; \
			else \
				echo "Error: neither curl nor wget is available" && exit 1; \
			fi; \
		fi; \
		if [ "$(RG_ARCHIVE_EXT)" = "zip" ]; then \
			ARCHIVE_PATH="$$ARCHIVE_PATH" TMP_DIR="$(TMP_DIR)" python -c "import os, zipfile; zipfile.ZipFile(os.environ['ARCHIVE_PATH']).extractall(os.environ['TMP_DIR'])"; \
		else \
			tar -xzf "$$ARCHIVE_PATH" -C "$(TMP_DIR)"; \
		fi; \
		SRC_PATH="$(TMP_DIR)/ripgrep-$(RG_VERSION)-$(RG_TARGET)/$(RG_ARCHIVE_BIN)"; \
		DST_PATH="$(BIN_DIR)/rg$(RG_BIN_SUFFIX)"; \
		cp "$$SRC_PATH" "$$DST_PATH"; \
		chmod +x "$$DST_PATH"; \
		echo "rg installed at $$DST_PATH"; \
	fi


.PHONY: download-deps
download-deps: download-ripgrep
