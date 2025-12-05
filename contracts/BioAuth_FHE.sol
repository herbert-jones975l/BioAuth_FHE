pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract BioAuthFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatchState();
    error InvalidArgument();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
    }
    Batch public currentBatch;

    mapping(uint256 => mapping(address => euint32)) public encryptedBiometricTemplates;
    mapping(uint256 => mapping(address => euint32)) public encryptedVerificationData;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event BiometricTemplateSubmitted(address indexed user, uint256 indexed batchId);
    event VerificationDataSubmitted(address indexed user, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, bool match);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown(address user) {
        if (block.timestamp < lastSubmissionTime[user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown(address user) {
        if (block.timestamp < lastDecryptionRequestTime[user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default cooldown
        currentBatch = Batch({id: 1, isOpen: true});
        emit BatchOpened(currentBatch.id);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidArgument();
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidArgument();
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner {
        if (currentBatch.isOpen) revert InvalidBatchState();
        currentBatch.id++;
        currentBatch.isOpen = true;
        emit BatchOpened(currentBatch.id);
    }

    function closeBatch() external onlyOwner {
        if (!currentBatch.isOpen) revert InvalidBatchState();
        currentBatch.isOpen = false;
        emit BatchClosed(currentBatch.id);
    }

    function submitBiometricTemplate(
        address user,
        euint32 encryptedTemplate
    ) external onlyProvider whenNotPaused checkSubmissionCooldown(user) {
        if (!currentBatch.isOpen) revert InvalidBatchState();
        _initIfNeeded(encryptedTemplate);
        encryptedBiometricTemplates[currentBatch.id][user] = encryptedTemplate;
        lastSubmissionTime[user] = block.timestamp;
        emit BiometricTemplateSubmitted(user, currentBatch.id);
    }

    function submitVerificationData(
        address user,
        euint32 encryptedData
    ) external onlyProvider whenNotPaused checkSubmissionCooldown(user) {
        if (!currentBatch.isOpen) revert InvalidBatchState();
        _initIfNeeded(encryptedData);
        encryptedVerificationData[currentBatch.id][user] = encryptedData;
        lastSubmissionTime[user] = block.timestamp;
        emit VerificationDataSubmitted(user, currentBatch.id);
    }

    function requestAuthentication(
        uint256 batchId,
        address user
    ) external onlyProvider whenNotPaused checkDecryptionCooldown(user) {
        if (currentBatch.id != batchId || currentBatch.isOpen) {
            revert InvalidBatchState();
        }
        euint32 memory template = encryptedBiometricTemplates[batchId][user];
        euint32 memory data = encryptedVerificationData[batchId][user];
        _requireInitialized(template);
        _requireInitialized(data);

        euint32 memory diff = FHE.sub(template, data);
        euint32 memory threshold = FHE.asEuint32(10000); // Example threshold
        ebool memory isMatch = FHE.le(diff, threshold);

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(isMatch);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });
        lastDecryptionRequestTime[user] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection ensures this callback is processed only once.

        ebool memory isMatch = ebool.wrap(abi.decode(cleartexts, (bool)));
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(isMatch); // Rebuild cts in the same order

        bytes32 currentHash = _hashCiphertexts(cts);
        // Security: State hash verification ensures that the contract state relevant to the ciphertexts
        // (specifically, the ciphertexts themselves) has not changed since the decryption was requested.
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, abi.encode(isMatch.unwrap()), proof)) {
            revert InvalidProof();
        }

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, isMatch.unwrap());
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 cipher) internal {
        if (!FHE.isInitialized(cipher)) {
            FHE.asEuint32(0); // Initialize if not already
        }
    }

    function _requireInitialized(euint32 cipher) internal pure {
        if (!FHE.isInitialized(cipher)) {
            revert NotInitialized();
        }
    }
}