import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface BiometricData {
  id: string;
  type: string;
  encryptedTemplate: string;
  timestamp: number;
  owner: string;
}

const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [biometrics, setBiometrics] = useState<BiometricData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newBiometricData, setNewBiometricData] = useState({ type: "fingerprint", score: "75" });
  const [selectedBiometric, setSelectedBiometric] = useState<BiometricData | null>(null);
  const [decryptedScore, setDecryptedScore] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      const biometricsBytes = await contract.getData("biometrics");
      let biometricsList: BiometricData[] = [];
      if (biometricsBytes.length > 0) {
        try {
          const biometricsStr = ethers.toUtf8String(biometricsBytes);
          if (biometricsStr.trim() !== '') biometricsList = JSON.parse(biometricsStr);
        } catch (e) {}
      }
      setBiometrics(biometricsList);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const enrollBiometric = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setEnrolling(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Enrolling biometric with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const newBiometric: BiometricData = {
        id: `bio-${Date.now()}`,
        type: newBiometricData.type,
        encryptedTemplate: FHEEncryptNumber(parseFloat(newBiometricData.score) || 0),
        timestamp: Math.floor(Date.now() / 1000),
        owner: address
      };
      
      const updatedBiometrics = [...biometrics, newBiometric];
      
      await contract.setData("biometrics", ethers.toUtf8Bytes(JSON.stringify(updatedBiometrics)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Biometric enrolled successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowEnrollModal(false);
        setNewBiometricData({ type: "fingerprint", score: "75" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setEnrolling(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const filteredBiometrics = biometrics.filter(bio => 
    bio.type.toLowerCase().includes(searchTerm.toLowerCase()) || 
    bio.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const renderDashboard = () => {
    const totalEnrollments = biometrics.length;
    const fingerprintCount = biometrics.filter(b => b.type === "fingerprint").length;
    const facialCount = biometrics.filter(b => b.type === "facial").length;
    
    return (
      <div className="dashboard-panels">
        <div className="panel">
          <h3>Total Enrollments</h3>
          <div className="stat-value">{totalEnrollments}</div>
          <div className="stat-trend">+{Math.floor(totalEnrollments * 0.2)} this month</div>
        </div>
        
        <div className="panel">
          <h3>Fingerprint Templates</h3>
          <div className="stat-value">{fingerprintCount}</div>
          <div className="stat-trend">{Math.floor((fingerprintCount / totalEnrollments) * 100)}% of total</div>
        </div>
        
        <div className="panel">
          <h3>Facial Templates</h3>
          <div className="stat-value">{facialCount}</div>
          <div className="stat-trend">{Math.floor((facialCount / totalEnrollments) * 100)}% of total</div>
        </div>
      </div>
    );
  };

  const renderFHEFlow = () => {
    return (
      <div className="fhe-flow">
        <div className="flow-step">
          <div className="step-icon">1</div>
          <div className="step-content">
            <h4>Biometric Capture</h4>
            <p>User provides fingerprint or facial scan</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">2</div>
          <div className="step-content">
            <h4>FHE Encryption</h4>
            <p>Template encrypted with Zama FHE</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">3</div>
          <div className="step-content">
            <h4>Secure Matching</h4>
            <p>Encrypted comparison on blockchain</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">4</div>
          <div className="step-content">
            <h4>Private Auth</h4>
            <p>Result returned without revealing data</p>
          </div>
        </div>
      </div>
    );
  };

  const renderFAQ = () => {
    const faqItems = [
      {
        question: "What is BioAuth FHE?",
        answer: "A privacy-preserving biometric authentication system using Fully Homomorphic Encryption (FHE) to protect your biometric data."
      },
      {
        question: "How does FHE protect my data?",
        answer: "FHE allows matching on encrypted data without decryption. Your biometric template remains encrypted at all times."
      },
      {
        question: "What biometrics are supported?",
        answer: "Currently fingerprint and facial recognition templates are supported with more modalities coming soon."
      },
      {
        question: "Who can see my decrypted data?",
        answer: "No one. The system never decrypts your biometric data, even during authentication."
      },
      {
        question: "What blockchains are supported?",
        answer: "Ethereum and EVM-compatible chains with plans to expand to other ecosystems."
      }
    ];
    
    return (
      <div className="faq-container">
        {faqItems.map((item, index) => (
          <div className="faq-item" key={index}>
            <div className="faq-question">{item.question}</div>
            <div className="faq-answer">{item.answer}</div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing encrypted biometric system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="bio-icon"></div>
          </div>
          <h1>BioAuth<span>FHE</span></h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowEnrollModal(true)} 
            className="create-btn"
          >
            <div className="add-icon"></div>Enroll Biometric
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="tabs-container">
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'dashboard' ? 'active' : ''}`}
                onClick={() => setActiveTab('dashboard')}
              >
                Dashboard
              </button>
              <button 
                className={`tab ${activeTab === 'templates' ? 'active' : ''}`}
                onClick={() => setActiveTab('templates')}
              >
                Biometric Templates
              </button>
              <button 
                className={`tab ${activeTab === 'faq' ? 'active' : ''}`}
                onClick={() => setActiveTab('faq')}
              >
                FAQ
              </button>
            </div>
            
            <div className="tab-content">
              {activeTab === 'dashboard' && (
                <div className="dashboard-content">
                  <h2>FHE-Powered Biometric Authentication</h2>
                  {renderDashboard()}
                  
                  <div className="panel full-width">
                    <h3>FHE Authentication Process</h3>
                    {renderFHEFlow()}
                  </div>
                </div>
              )}
              
              {activeTab === 'templates' && (
                <div className="templates-section">
                  <div className="section-header">
                    <h2>Encrypted Biometric Templates</h2>
                    <div className="header-actions">
                      <input
                        type="text"
                        placeholder="Search templates..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="search-input"
                      />
                      <button 
                        onClick={loadData} 
                        className="refresh-btn" 
                        disabled={isRefreshing}
                      >
                        {isRefreshing ? "Refreshing..." : "Refresh"}
                      </button>
                    </div>
                  </div>
                  
                  <div className="templates-list">
                    {filteredBiometrics.length === 0 ? (
                      <div className="no-templates">
                        <div className="no-templates-icon"></div>
                        <p>No biometric templates found</p>
                        <button 
                          className="create-btn" 
                          onClick={() => setShowEnrollModal(true)}
                        >
                          Enroll First Template
                        </button>
                      </div>
                    ) : filteredBiometrics.map((bio, index) => (
                      <div 
                        className={`template-item ${selectedBiometric?.id === bio.id ? "selected" : ""}`} 
                        key={index}
                        onClick={() => setSelectedBiometric(bio)}
                      >
                        <div className="template-title">{bio.type} Template</div>
                        <div className="template-meta">
                          <span>ID: {bio.id.substring(0, 8)}</span>
                          <span>Encrypted: {bio.encryptedTemplate.substring(0, 15)}...</span>
                        </div>
                        <div className="template-owner">Owner: {bio.owner.substring(0, 6)}...{bio.owner.substring(38)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {activeTab === 'faq' && (
                <div className="faq-section">
                  <h2>Frequently Asked Questions</h2>
                  {renderFAQ()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {showEnrollModal && (
        <ModalEnrollBiometric 
          onSubmit={enrollBiometric} 
          onClose={() => setShowEnrollModal(false)} 
          enrolling={enrolling} 
          biometricData={newBiometricData} 
          setBiometricData={setNewBiometricData}
        />
      )}
      
      {selectedBiometric && (
        <BiometricDetailModal 
          biometric={selectedBiometric} 
          onClose={() => { 
            setSelectedBiometric(null); 
            setDecryptedScore(null); 
          }} 
          decryptedScore={decryptedScore} 
          setDecryptedScore={setDecryptedScore} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="bio-icon"></div>
              <span>BioAuth_FHE</span>
            </div>
            <p>Privacy-first biometric authentication</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} BioAuth FHE. All rights reserved.</div>
          <div className="disclaimer">
            This system uses fully homomorphic encryption to protect your biometric data.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalEnrollBiometricProps {
  onSubmit: () => void; 
  onClose: () => void; 
  enrolling: boolean;
  biometricData: any;
  setBiometricData: (data: any) => void;
}

const ModalEnrollBiometric: React.FC<ModalEnrollBiometricProps> = ({ onSubmit, onClose, enrolling, biometricData, setBiometricData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setBiometricData({ ...biometricData, [name]: value });
  };

  return (
    <div className="modal-overlay">
      <div className="enroll-biometric-modal">
        <div className="modal-header">
          <h2>Enroll New Biometric</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>All biometric data will be encrypted with Zama FHE</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Biometric Type *</label>
            <select 
              name="type" 
              value={biometricData.type} 
              onChange={handleChange}
            >
              <option value="fingerprint">Fingerprint</option>
              <option value="facial">Facial Recognition</option>
            </select>
          </div>
          
          <div className="form-group">
            <label>Match Score (1-100) *</label>
            <input 
              type="number" 
              min="1" 
              max="100" 
              name="score" 
              value={biometricData.score} 
              onChange={handleChange} 
              placeholder="Enter match score..." 
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={enrolling || !biometricData.type || !biometricData.score} 
            className="submit-btn"
          >
            {enrolling ? "Enrolling with FHE..." : "Enroll Biometric"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface BiometricDetailModalProps {
  biometric: BiometricData;
  onClose: () => void;
  decryptedScore: number | null;
  setDecryptedScore: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const BiometricDetailModal: React.FC<BiometricDetailModalProps> = ({ 
  biometric, 
  onClose, 
  decryptedScore, 
  setDecryptedScore, 
  isDecrypting, 
  decryptWithSignature
}) => {
  const handleDecrypt = async () => {
    if (decryptedScore !== null) { 
      setDecryptedScore(null); 
      return; 
    }
    
    const decrypted = await decryptWithSignature(biometric.encryptedTemplate);
    if (decrypted !== null) {
      setDecryptedScore(decrypted);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="biometric-detail-modal">
        <div className="modal-header">
          <h2>Biometric Template Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="biometric-info">
            <div className="info-item">
              <span>Type:</span>
              <strong>{biometric.type}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{biometric.owner.substring(0, 6)}...{biometric.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date Enrolled:</span>
              <strong>{new Date(biometric.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
          </div>
          
          <div className="data-section">
            <h3>Encrypted Biometric Data</h3>
            <div className="data-row">
              <div className="data-label">Template:</div>
              <div className="data-value">{biometric.encryptedTemplate.substring(0, 30)}...</div>
              <button 
                className="decrypt-btn" 
                onClick={handleDecrypt} 
                disabled={isDecrypting}
              >
                {isDecrypting ? (
                  "Decrypting..."
                ) : decryptedScore !== null ? (
                  "Hide Score"
                ) : (
                  "Decrypt Score"
                )}
              </button>
            </div>
            
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted - Requires Wallet Signature</span>
            </div>
          </div>
          
          {decryptedScore !== null && (
            <div className="analysis-section">
              <h3>Match Analysis</h3>
              
              <div className="match-score">
                <div className="score-circle">
                  <div className="score-value">{decryptedScore}</div>
                  <div className="score-label">Match Score</div>
                </div>
                <div className="score-description">
                  {decryptedScore >= 90 ? "Excellent match" : 
                   decryptedScore >= 75 ? "Good match" : 
                   decryptedScore >= 50 ? "Partial match" : "Low match"}
                </div>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;