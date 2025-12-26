import { useState, useRef, useEffect } from 'react';
import './App.css';

const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 3;
const API_BASE = 'http://localhost:3001/api';

function App() {
  const [file, setFile] = useState(null);
  const [uploadId, setUploadId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [chunks, setChunks] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState(0);
  const [eta, setEta] = useState(0);
  const fileInputRef = useRef(null);
  const uploadStateRef = useRef({
    activeUploads: 0,
    queue: [],
    uploadedBytes: 0,
    startTime: 0,
    lastUpdate: 0,
    lastBytes: 0
  });

  useEffect(() => {
    if (!uploading || chunks.length === 0 || !file) return;

    const interval = setInterval(() => {
      const state = uploadStateRef.current;
      const now = Date.now();
      const timeSinceLastUpdate = (now - state.lastUpdate) / 1000;

      if (timeSinceLastUpdate >= 1) {
        const bytesDiff = state.uploadedBytes - state.lastBytes;
        const instantSpeed = bytesDiff / timeSinceLastUpdate / (1024 * 1024);

        setUploadSpeed(instantSpeed);

        const totalSize = file.size;
        const remaining = totalSize - state.uploadedBytes;
        if (instantSpeed > 0) {
          const etaSeconds = Math.ceil(remaining / (instantSpeed * 1024 * 1024));
          setEta(etaSeconds);
        }

        state.lastUpdate = now;
        state.lastBytes = state.uploadedBytes;
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [uploading, chunks, file]);

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    setFile(selectedFile);

    const savedUpload = localStorage.getItem('currentUpload');
    if (savedUpload) {
      const data = JSON.parse(savedUpload);
      if (data.filename === selectedFile.name && data.fileSize === selectedFile.size) {
        const confirmed = window.confirm(
          'This file has a previous incomplete upload. Do you want to resume it?'
        );
        if (confirmed) {
          setUploadId(data.uploadId);
        } else {
          localStorage.removeItem('currentUpload');
          setUploadId('');
        }
      }
    }

    const totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE);
    const newChunks = Array.from({ length: totalChunks }, (_, i) => ({
      index: i,
      status: 'pending',
      retries: 0
    }));
    setChunks(newChunks);
    setUploadProgress(0);
    setUploadSpeed(0);
    setEta(0);
  };

  const startUpload = async () => {
    if (!file) return;

    let id = uploadId;
    let fileSize = file.size;
    let filename = file.name;

    if (!uploadId) {
      id = generateUploadId(file);
      setUploadId(id);
    }

    localStorage.setItem('currentUpload', JSON.stringify({
      uploadId: id,
      filename,
      fileSize
    }));

    try {
      const response = await fetch(`${API_BASE}/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId: id,
          filename,
          fileSize
        })
      });

      const data = await response.json();

      const alreadyUploaded = data.uploadedChunks.length * CHUNK_SIZE;
      const now = Date.now();

      uploadStateRef.current = {
        activeUploads: 0,
        queue: [],
        uploadedBytes: alreadyUploaded,
        startTime: now,
        lastUpdate: now,
        lastBytes: alreadyUploaded
      };

      setChunks(prev => prev.map(chunk => ({
        ...chunk,
        status: data.uploadedChunks.includes(chunk.index) ? 'success' : 'pending'
      })));

      setUploading(true);

      const pendingChunks = chunks
        .map((_, index) => index)
        .filter(index => !data.uploadedChunks.includes(index));

      uploadStateRef.current.queue = pendingChunks;
      processQueue(id);
    } catch (error) {
      console.error('Init failed:', error);
      setUploading(false);
    }
  };

  const processQueue = (id) => {
    const state = uploadStateRef.current;

    while (state.activeUploads < MAX_CONCURRENT && state.queue.length > 0) {
      const chunkIndex = state.queue.shift();
      state.activeUploads++;
      uploadChunk(id, chunkIndex);
    }

    if (state.activeUploads === 0 && state.queue.length === 0) {
      checkCompletion();
    }
  };

  const uploadChunk = async (id, chunkIndex, retryCount = 0) => {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    setChunks(prev => prev.map(c =>
      c.index === chunkIndex ? { ...c, status: 'uploading' } : c
    ));

    const shouldFail = Math.random() < 0.3;

    try {
      if (shouldFail) {
        throw new Error('Simulated network failure');
      }

      const formData = new FormData();
      formData.append('chunk', chunk);
      formData.append('uploadId', id);
      formData.append('chunkIndex', chunkIndex);
      formData.append('totalChunks', chunks.length);

      const response = await fetch(`${API_BASE}/upload/chunk`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) throw new Error('Upload failed');

      setChunks(prev => prev.map(c =>
        c.index === chunkIndex ? { ...c, status: 'success', retries: retryCount } : c
      ));

      uploadStateRef.current.uploadedBytes += chunk.size;
      updateProgress();

      uploadStateRef.current.activeUploads--;
      processQueue(id);
    } catch (error) {
      if (retryCount < MAX_RETRIES) {
        const delay = Math.pow(2, retryCount) * 1000;

        setChunks(prev => prev.map(c =>
          c.index === chunkIndex ? { ...c, status: 'error', retries: retryCount + 1 } : c
        ));

        setTimeout(() => {
          uploadChunk(id, chunkIndex, retryCount + 1);
        }, delay);
      } else {
        setChunks(prev => prev.map(c =>
          c.index === chunkIndex ? { ...c, status: 'failed', retries: retryCount } : c
        ));

        uploadStateRef.current.activeUploads--;
        processQueue(id);
      }
    }
  };

  const updateProgress = () => {
    if (!file) return;
    const total = file.size;
    const uploaded = uploadStateRef.current.uploadedBytes;
    const progress = Math.min((uploaded / total) * 100, 100);
    setUploadProgress(progress);
  };

  const checkCompletion = () => {
    const allSuccess = chunks.every(c => c.status === 'success');
    if (allSuccess) {
      setUploading(false);
      localStorage.removeItem('currentUpload');
      alert('Upload completed successfully!');
    }
  };

  const generateUploadId = (file) => {
    return `${file.name}-${file.size}-${Date.now()}`;
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatTime = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending': return '#666';
      case 'uploading': return '#3498db';
      case 'success': return '#2ecc71';
      case 'error': return '#f39c12';
      case 'failed': return '#e74c3c';
      default: return '#666';
    }
  };

  return (
    <div className='cont-top' style={{display:'flex', alignItems:'center', justifyContent:'center'}}>
    <div className="container">
      <h1>Large File Chunk Uploader</h1>

      <div className="upload-section">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept=".zip"
          disabled={uploading}
        />
        {file && (
          <div className="file-info">
            <p><strong>File:</strong> {file.name}</p>
            <p><strong>Size:</strong> {formatBytes(file.size)}</p>
            <p><strong>Chunks:</strong> {chunks.length}</p>
            {uploadId && (
              <p style={{ color: '#f39c12' }}><strong>⚠️ Resuming previous upload</strong></p>
            )}
          </div>
        )}
        <button
          onClick={startUpload}
          disabled={!file || uploading}
          className="upload-btn"
        >
          {uploading ? 'Uploading...' : (uploadId ? 'Resume Upload' : 'Start Upload')}
        </button>
      </div>

      {uploading && (
        <div className="progress-section">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <div className="progress-text">
            {uploadProgress.toFixed(2)}%
          </div>

          <div className="metrics">
            <div className="metric">
              <span className="metric-label">Speed:</span>
              <span className="metric-value">{uploadSpeed.toFixed(2)} MB/s</span>
            </div>
            <div className="metric">
              <span className="metric-label">ETA:</span>
              <span className="metric-value">{formatTime(eta)}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Uploaded:</span>
              <span className="metric-value">
                {formatBytes(uploadStateRef.current.uploadedBytes)} / {formatBytes(file.size)}
              </span>
            </div>
          </div>
        </div>
      )}

      {chunks.length > 0 && (
        <div className="chunks-section">
          <h2>Chunks Status</h2>
          <div className="chunk-grid">
            {chunks.map((chunk) => (
              <div
                key={chunk.index}
                className="chunk-item"
                style={{ backgroundColor: getStatusColor(chunk.status) }}
                title={`Chunk ${chunk.index}: ${chunk.status}${chunk.retries > 0 ? ` (retry ${chunk.retries})` : ''}`}
              >
                {chunk.index}
              </div>
            ))}
          </div>
          <div className="chunk-legend">
            <div className="legend-item">
              <div className="legend-color" style={{ backgroundColor: '#666' }}></div>
              <span>Pending</span>
            </div>
            <div className="legend-item">
              <div className="legend-color" style={{ backgroundColor: '#3498db' }}></div>
              <span>Uploading</span>
            </div>
            <div className="legend-item">
              <div className="legend-color" style={{ backgroundColor: '#2ecc71' }}></div>
              <span>Success</span>
            </div>
            <div className="legend-item">
              <div className="legend-color" style={{ backgroundColor: '#f39c12' }}></div>
              <span>Retrying</span>
            </div>
            <div className="legend-item">
              <div className="legend-color" style={{ backgroundColor: '#e74c3c' }}></div>
              <span>Failed</span>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}

export default App;
