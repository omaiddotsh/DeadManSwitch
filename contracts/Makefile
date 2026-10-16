.PHONY: deps build test lint gas gas-check fmt sizes deploy-anvil deploy-sepolia deploy-mainnet

# anvil dev account #0 — local only, never use on a public network
ANVIL_PK := 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Chainlink ETH/USD price feeds
PRICE_FEED_ETHEREUM := 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419
PRICE_FEED_SEPOLIA  := 0x694AA1769357215DE4FAC081bf1f309aDC325306

# Etherscan verification for the public deploy targets. VERIFY=0 deploys without it
# (verify later with `forge verify-contract`, PRODUCTION-SETUP.md §4).
VERIFY ?= 1
VERIFY_FLAGS = $(if $(filter 0,$(VERIFY)),,--verify --etherscan-api-key $$ETHERSCAN_API_KEY)

# Guards shared by the public deploy targets. None of them prints a secret.
# forge also reads contracts/.env (a variable already set in the environment wins), so
# the guards look at both: $(call IN_DOTENV,NAME) succeeds when .env gives NAME a value.
IN_DOTENV = grep -Eqs '^[[:space:]]*(export[[:space:]]+)?$(1)[[:space:]]*=[[:space:]]*[^[:space:]\#]' .env
PK_SET = { [ -n "$$PRIVATE_KEY" ] || $(call IN_DOTENV,PRIVATE_KEY); }
# ETH_PASSWORD is forge's --password-file: the PATH of a regular file holding the
# keystore password, never the password itself (forge would print it in a "file does
# not exist" error). Forge rejects pipes such as <(security ...). Leave it unset to be
# prompted, or use a private temporary file that is removed when the deploy ends.
CHECK_PASSWORD = if $(call IN_DOTENV,ETH_PASSWORD); then echo "refusing: contracts/.env sets ETH_PASSWORD; remove it there (forge reads it as a password file path, and would print a password put there); set it in the environment, or leave it unset to be prompted"; exit 1; fi; if [ -n "$$ETH_PASSWORD" ] && { [ ! -f "$$ETH_PASSWORD" ] || [ ! -r "$$ETH_PASSWORD" ]; }; then echo "refusing: ETH_PASSWORD must be the path of a readable regular file holding the keystore password, not the password itself (forge reads it as --password-file; pipes do not work); unset it to be prompted"; exit 1; fi
CHECK_VERIFY = if [ "$(VERIFY)" != 0 ] && [ -z "$$ETHERSCAN_API_KEY" ]; then echo "set ETHERSCAN_API_KEY, or VERIFY=0 to deploy without Etherscan verification"; exit 1; fi

deps:
	forge soldeer install

build:
	forge build

sizes:
	forge build --sizes

test:
	forge test -vv

# -D notes: any lint note or warning fails (plain `forge lint` exits 0).
# Builds first: when forge lint (1.5.1) is the one compiling a changed file, it writes an
# artifact without bytecode that later builds reuse ("Could not find target contract").
lint: build
	forge lint -D notes src script

# Unit tests only: fuzz/invariant gas is not deterministic.
gas:
	forge snapshot --no-match-test "testFuzz|invariant|test_Invariant"

gas-check:
	forge snapshot --no-match-test "testFuzz|invariant|test_Invariant" --check --tolerance 2

fmt:
	forge fmt

# Local — assumes `anvil` on :8545 with the forge-fhevm host stack deployed
# (see ../scripts/local-e2e.sh). No price feed locally: bounty floor disabled.
deploy-anvil:
	PRIVATE_KEY=$(ANVIL_PK) forge script script/Deploy.s.sol \
	  --rpc-url http://localhost:8545 --broadcast

# Sepolia rehearsal: ACCOUNT=<keystore> or LEDGER=1 with SENDER=0x...; PRIVATE_KEY
# accepted only for a throwaway key, and never together with ACCOUNT/LEDGER (the
# script would sign with PRIVATE_KEY), whether it is in the environment or in .env. NEW_ADMIN is passed inline so the printed
# command is complete when copied.
#   make deploy-sepolia ACCOUNT=dms-deployer SENDER=0x... NEW_ADMIN=0xSafe
#   make deploy-sepolia LEDGER=1 SENDER=0x... NEW_ADMIN=0xSafe
deploy-sepolia:
	@if [ -z "$$SEPOLIA_RPC_URL" ]; then echo "set SEPOLIA_RPC_URL=https://..."; exit 1; fi
	@if ! $(PK_SET) && [ -z "$(ACCOUNT)" ] && [ -z "$(LEDGER)" ]; then echo "set ACCOUNT=<keystore> or LEDGER=1 with SENDER=0x... (or PRIVATE_KEY for a throwaway key)"; exit 1; fi
	@if $(PK_SET) && [ -n "$(ACCOUNT)$(LEDGER)" ]; then echo "refusing: PRIVATE_KEY is set (in the environment or contracts/.env) and Deploy.s.sol would sign with it instead of ACCOUNT/LEDGER; unset it"; exit 1; fi
	@if ! $(PK_SET) && [ -z "$(SENDER)" ]; then echo "set SENDER=0x... (the deployer address)"; exit 1; fi
	@$(CHECK_PASSWORD)
	@$(CHECK_VERIFY)
	NEW_ADMIN=$(NEW_ADMIN) ETH_USD_PRICE_FEED=$(PRICE_FEED_SEPOLIA) MIN_BOUNTY_USD=$${MIN_BOUNTY_USD:-1000000000} \
	forge script script/Deploy.s.sol \
	  --rpc-url $$SEPOLIA_RPC_URL \
	  $(if $(ACCOUNT),--account $(ACCOUNT) --sender $(SENDER),$(if $(LEDGER),--ledger --sender $(SENDER),)) \
	  --broadcast $(VERIFY_FLAGS)

# Mainnet: encrypted keystore or Ledger only, admin handed to a multisig.
#   make deploy-mainnet ACCOUNT=<cast wallet name> SENDER=0x... NEW_ADMIN=0xMultisig
#   make deploy-mainnet LEDGER=1 SENDER=0x... NEW_ADMIN=0xMultisig
deploy-mainnet:
	@if $(PK_SET); then echo "refusing: unset PRIVATE_KEY (in the environment and in contracts/.env); use ACCOUNT=<keystore> or LEDGER=1"; exit 1; fi
	@if [ -z "$$ETH_RPC_URL" ]; then echo "set ETH_RPC_URL=https://..."; exit 1; fi
	@if [ -z "$(SENDER)" ]; then echo "set SENDER=0x... (the deployer address)"; exit 1; fi
	@if [ -z "$(NEW_ADMIN)" ]; then echo "set NEW_ADMIN=0x... (a multisig)"; exit 1; fi
	@if [ -z "$(ACCOUNT)" ] && [ -z "$(LEDGER)" ]; then echo "set ACCOUNT=<keystore> or LEDGER=1"; exit 1; fi
	@$(CHECK_PASSWORD)
	@$(CHECK_VERIFY)
	NEW_ADMIN=$(NEW_ADMIN) ETH_USD_PRICE_FEED=$(PRICE_FEED_ETHEREUM) MIN_BOUNTY_USD=$${MIN_BOUNTY_USD:-1000000000} \
	forge script script/Deploy.s.sol \
	  --rpc-url $$ETH_RPC_URL --sender $(SENDER) \
	  $(if $(ACCOUNT),--account $(ACCOUNT),--ledger) \
	  --broadcast $(VERIFY_FLAGS)
