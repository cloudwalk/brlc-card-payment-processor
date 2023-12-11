// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title ERC20UpgradeableMock contract
 * @dev An implementation of the {ERC20Upgradeable} contract for test purposes.
 */
contract ERC20UpgradeableMock is ERC20Upgradeable {
    bool public mintResult;

    /// @notice Mapping of presence in the blocklist for a given address
    mapping(address => bool) private _blocklisted;

    /**
     * @notice The account is blocklisted
     *
     * @param account The address of the blocklisted account
     */
    error BlocklistedAccount(address account);

    /**
     * @notice Throws if the account is blocklisted
     *
     * @param account The address to check for presence in the blocklist
     */
    modifier notBlacklisted(address account) {
        if (_blocklisted[account]) {
            revert BlocklistedAccount(account);
        }
        _;
    }

    /**
     * @dev The initialize function of the upgradable contract.
     * @param name_ The name of the token to set for this ERC20-comparable contract.
     * @param symbol_ The symbol of the token to set for this ERC20-comparable contract.
     */
    function initialize(string memory name_, string memory symbol_) public initializer {
        __ERC20_init(name_, symbol_);
        mintResult = true;
    }

    /**
     * @dev Calls the appropriate internal function to mint needed amount of tokens for an account.
     * @param account The address of an account to mint for.
     * @param amount The amount of tokens to mint.
     */
    function mint(address account, uint256 amount) external returns (bool) {
        _mint(account, amount);
        return mintResult;
    }

    /**
     * @dev Calls the appropriate internal function to burn needed amount of tokens.
     * @param amount The amount of tokens of this contract to burn.
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function setMintResult(bool _newMintResult) external {
        mintResult = _newMintResult;
    }

    /**
     * @notice Adds an account to the blocklist
     *
     * @param account The address to blocklist
     */
    function blacklist(address account) public {
        if (_blocklisted[account]) {
            return;
        }

        _blocklisted[account] = true;
    }

    /**
     * @notice Removes an account from the blocklist
     *
     * @param account The address to remove from the blocklist
     */
    function unBlacklist(address account) public {
        if (!_blocklisted[account]) {
            return;
        }
        _blocklisted[account] = false;
    }

    /**
     * @notice Checks if an account is present in the blocklist
     *
     * @param account The address to check for presence in the blocklist
     * @return True if the account is present in the blocklist, false otherwise
     */
    function isBlacklisted(address account) public view returns (bool) {
        return _blocklisted[account];
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override notBlacklisted(from) notBlacklisted(to) {
        super._beforeTokenTransfer(from, to, amount);
    }

}
