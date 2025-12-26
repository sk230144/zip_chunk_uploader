# Large File Chunk Uploader System

A production-ready file upload system designed to handle large files (>1GB) with advanced features like chunking, resumability, retry logic, and crash recovery.

## Tech Stack

- **Frontend**: React.js with Vite
- **Backend**: Node.js with Express
- **Database**: MongoDB 7.0
- **File Processing**: Node.js Streams
- **ZIP Handling**: yauzl
- **Hashing**: SHA-256
- **Containerization**: Docker & Docker Compose

## Features

### Frontend Capabilities
- Large file selection and chunking (5MB chunks)
- Concurrent upload control (max 3 simultaneous uploads)
- Smart retry mechanism with exponential backoff
- Real-time progress visualization
- Upload/download speed tracking
- ETA calculation
- Chunk status monitoring
- Resume support after page refresh
- Simulated 30% network failure for testing

### Backend Capabilities
- Streaming-based chunk receiving (no full file in memory)
- Out-of-order chunk assembly
- Idempotent chunk handling
- Atomic finalization with race condition protection
- SHA-256 file integrity verification
- ZIP content preview without extraction
- Automatic cleanup of orphaned uploads
- Crash recovery support

### Database
- Upload tracking with status management
- Individual chunk status monitoring
- Document-based storage with MongoDB
- Optimized indexes for performance

## Architecture

### Upload Flow

1. **Initialization**: Client sends file metadata to `/api/upload/init`
   - Server creates upload record in database
   - Returns upload ID and list of already uploaded chunks
   - Client resumes from where it left off

2. **Chunking**: File is split into 5MB chunks
   - Each chunk gets an index (0, 1, 2, ...)
   - Chunks are queued for upload

3. **Concurrent Upload**: Max 3 chunks upload simultaneously
   - Queue management ensures controlled concurrency
   - Network failures trigger exponential backoff retry

4. **Chunk Assembly**: Backend writes chunks at correct byte offsets
   - Uses `fs.open` with position-based writes
   - Supports out-of-order chunk arrival
   - Idempotent handling prevents corruption

5. **Finalization**: When all chunks received
   - Atomic status update prevents double-finalization
   - SHA-256 hash calculated for integrity
   - ZIP contents listed without extraction

## How File Integrity is Handled

The system implements multiple layers of file integrity verification:

### 1. SHA-256 Hash Calculation
When all chunks are received, the backend calculates a SHA-256 hash of the complete assembled file:

```javascript
// server.js - calculateFileHash()
function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);

    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
```

**Benefits:**
- Verifies the complete file was assembled correctly
- Detects any corruption during upload or assembly
- Stored in database for future verification
- Can be compared against original file hash if provided

### 2. Chunk Tracking in Database
Each chunk's status is recorded in MongoDB:

```javascript
{
  upload_id: "file-123",
  chunk_index: 5,
  status: "RECEIVED",
  received_at: ISODate("2025-12-26T...")
}
```

**Benefits:**
- Prevents duplicate chunk uploads (idempotency)
- Enables accurate resume functionality
- Provides audit trail of upload progress

### 3. Idempotent Chunk Handling
Before writing each chunk, the backend checks if it was already received:

```javascript
// server.js - chunk upload endpoint
const existingChunk = await db.collection('chunks').findOne({
  upload_id: uploadId,
  chunk_index: chunkIdx
});

if (existingChunk && existingChunk.status === 'RECEIVED') {
  return res.json({ success: true, message: 'Chunk already uploaded' });
}
```

**Benefits:**
- Safe retry mechanism without file corruption
- Handles network issues gracefully
- Prevents duplicate writes to same file position

### 4. Offset-Based Writing
Chunks are written to their exact position in the target file using file offsets:

```javascript
// server.js - chunk upload
const offset = chunkIdx * CHUNK_SIZE;
const fileHandle = await fs.open(targetPath, 'r+').catch(() => fs.open(targetPath, 'w'));
await fileHandle.write(chunkData, 0, chunkData.length, offset);
```

**Benefits:**
- Supports out-of-order chunk arrival
- File assembles correctly regardless of upload sequence
- No need to store chunks separately and merge later

### 5. Atomic Finalization
Prevents race conditions when multiple final chunks arrive simultaneously:

```javascript
// server.js - finalizeUpload()
const uploadDoc = await db.collection('uploads').findOne({ id: uploadId });
if (!uploadDoc || uploadDoc.status !== 'UPLOADING') {
  return; // Already finalized
}
await db.collection('uploads').updateOne(
  { id: uploadId },
  { $set: { status: 'PROCESSING' } }
);
```

**Benefits:**
- Guarantees finalization runs only once
- Prevents duplicate hash calculations
- Ensures consistent final state

## How Pause/Resume Logic Works

The system implements a robust pause/resume mechanism using localStorage and database state:

### Client-Side State Persistence

**1. Saving Upload State:**
When an upload starts, the frontend saves metadata to localStorage:

```javascript
// App.jsx - startUpload()
localStorage.setItem('currentUpload', JSON.stringify({
  uploadId: id,
  filename: file.name,
  fileSize: file.size
}));
```

**2. Detecting Resumable Uploads:**
When the user selects a file, the system checks for matching incomplete uploads:

```javascript
// App.jsx - handleFileSelect()
const savedUpload = localStorage.getItem('currentUpload');
if (savedUpload) {
  const data = JSON.parse(savedUpload);
  if (data.filename === selectedFile.name && data.fileSize === selectedFile.size) {
    // Prompt user to resume
    const confirmed = window.confirm('Resume previous upload?');
    if (confirmed) {
      setUploadId(data.uploadId); // Use existing upload ID
    }
  }
}
```

### Server-Side Handshake

**3. Upload Initialization Handshake:**
Before uploading chunks, the client queries the server:

```javascript
// POST /api/upload/init
const response = await fetch(`${API_BASE}/upload/init`, {
  method: 'POST',
  body: JSON.stringify({ uploadId, filename, fileSize })
});

const data = await response.json();
// Returns: { uploadId, uploadedChunks: [0, 2, 5, ...], status: 'UPLOADING' }
```

**4. Backend State Lookup:**
The server checks MongoDB for existing upload progress:

```javascript
// server.js - /api/upload/init
const existing = await db.collection('uploads').findOne({ id: uploadId });
if (existing) {
  const chunks = await db.collection('chunks')
    .find({ upload_id: uploadId })
    .toArray();

  const uploadedChunks = chunks
    .filter(c => c.status === 'RECEIVED')
    .map(c => c.chunk_index);

  return res.json({ uploadId, uploadedChunks, status: existing.status });
}
```

### Resume Execution

**5. Skipping Completed Chunks:**
The frontend only uploads chunks not in the `uploadedChunks` array:

```javascript
// App.jsx - startUpload()
setChunks(prev => prev.map(chunk => ({
  ...chunk,
  status: data.uploadedChunks.includes(chunk.index) ? 'success' : 'pending'
})));

const pendingChunks = chunks
  .map((_, index) => index)
  .filter(index => !data.uploadedChunks.includes(index));
```

### Complete Flow

1. **Initial Upload:** User uploads file → localStorage saves metadata
2. **Page Refresh:** Browser refreshed mid-upload → State lost but localStorage persists
3. **File Re-selection:** User selects same file → System detects match
4. **Resume Prompt:** "Resume previous upload?" → User confirms
5. **Server Handshake:** Client sends uploadId → Server returns completed chunks
6. **Smart Resume:** Only missing chunks upload → File completes successfully
7. **Cleanup:** Upload complete → localStorage cleared

**Key Benefits:**
- Works across browser sessions
- No data loss from page refresh
- Bandwidth efficient (no re-upload)
- Server is source of truth
- Client state recoverable

## Known Trade-offs

### 1. Database Choice (MongoDB)
**Decision:** Use MongoDB instead of PostgreSQL/MySQL
**Trade-off:** MongoDB uses eventual consistency vs strict ACID transactions
**Impact:**
- Slight risk of race conditions in concurrent scenarios
- Mitigated by application-level checks before finalization
- Gain: Better scalability and flexible schema

### 2. Chunk Size (5MB)
**Decision:** Fixed 5MB chunk size
**Trade-off:**
- Smaller chunks (1MB) = More HTTP overhead, more DB records, but better retry granularity
- Larger chunks (50MB) = Less overhead, fewer DB records, but wasted bandwidth on retry
**Impact:**
- 5MB balances performance with reliability
- For 1GB file = 200 chunks (manageable)
- Each failed chunk wastes max 5MB on retry

### 3. Concurrency Limit (3)
**Decision:** Maximum 3 concurrent chunk uploads
**Trade-off:**
- Higher concurrency (10+) = Faster uploads but overwhelming server/network
- Lower concurrency (1) = Slower but safer
**Impact:**
- 3 concurrent uploads provide good balance
- Prevents browser/server resource exhaustion
- Could be made configurable for different network conditions

### 4. Client-Side Retry Logic
**Decision:** Frontend handles retries with exponential backoff
**Trade-off:** Backend doesn't retry, relies on client
**Impact:**
- Simpler backend implementation
- Network issues handled gracefully by client
- Client must remain active for retries to work
- Backend focuses on idempotency instead

### 5. In-Memory Upload State
**Decision:** Store uploadState in React ref (memory)
**Trade-off:** Lost on page refresh vs persisting to IndexedDB
**Impact:**
- Simpler implementation
- Faster access to state
- User must re-select file after refresh (acceptable UX)
- Database handshake recovers actual upload progress

### 6. Single File Upload
**Decision:** Support one file upload at a time
**Trade-off:** No parallel file uploads
**Impact:**
- Simpler UI/UX
- Less complex state management
- Sufficient for most use cases
- Could be extended to multi-file in future

### 7. ZIP Peek Without Extraction
**Decision:** Use yauzl to list files without extracting
**Trade-off:** Only top-level filenames visible
**Impact:**
- Memory efficient
- Fast processing
- Limited inspection depth
- Sufficient for verification purposes

### 8. 30% Simulated Failure Rate
**Decision:** Hard-coded network failure simulation
**Trade-off:** Always active in production vs config flag
**Impact:**
- Great for testing/demo
- Should be removed or made configurable for production
- Demonstrates retry mechanism effectively

### 9. Cleanup Interval (24 hours)
**Decision:** Delete incomplete uploads after 24 hours
**Trade-off:** Some users may want longer retention
**Impact:**
- Prevents disk space bloat
- Simple implementation
- Could be configurable per use case
- Edge case: User loses progress if inactive >24h

### 10. Localhost-Only Speed
**Decision:** No artificial delay in production build
**Trade-off:** Very fast on localhost, hard to observe chunking
**Impact:**
- True performance in production
- For demo/testing, can add configurable delay
- Speed metrics accurate but may show very high MB/s locally

## Future Enhancements

### Performance Improvements
1. **Adaptive Chunk Size**
   - Dynamically adjust chunk size based on network speed
   - Larger chunks for fast connections, smaller for slow/unstable

2. **WebSocket Progress Updates**
   - Real-time server-to-client progress notifications
   - Better UX for long uploads
   - Server can notify client of chunk receipt

3. **Parallel File Assembly**
   - Use worker threads for hash calculation
   - Non-blocking ZIP peek operation
   - Faster finalization for large files

4. **CDN Integration**
   - Direct uploads to S3/CloudFront
   - Signed URLs for secure uploads
   - Reduce server bandwidth costs

5. **Compression**
   - Client-side compression before chunking
   - Smaller upload sizes
   - Decompression on server

### Feature Additions
1. **Multi-File Upload**
   - Queue multiple files
   - Progress tracking per file
   - Batch operations

2. **Drag & Drop Interface**
   - More intuitive file selection
   - Visual upload zones
   - Progress overlays

3. **Upload History**
   - List of previous uploads
   - Re-download capability
   - Upload statistics

4. **File Preview**
   - Thumbnail generation for images
   - Preview ZIP contents in UI
   - File type detection

5. **Pause/Resume Button**
   - Manual pause control
   - Bandwidth throttling
   - Scheduled uploads

### Security Enhancements
1. **Authentication & Authorization**
   - User login system
   - JWT token authentication
   - Per-user upload limits

2. **File Validation**
   - MIME type verification
   - File size limits
   - Malware scanning integration

3. **Rate Limiting**
   - Per-IP upload limits
   - Prevent abuse
   - DDoS protection

4. **Encryption**
   - End-to-end encryption
   - Client-side encryption before upload
   - Secure storage

5. **Signed Upload URLs**
   - Time-limited upload permissions
   - Prevent unauthorized uploads
   - Revocable access

### Reliability Improvements
1. **Redis Caching**
   - Cache chunk status in Redis
   - Faster resume lookups
   - Reduced database load

2. **Circuit Breaker**
   - Automatic failure detection
   - Graceful degradation
   - Backend health monitoring

3. **Retry Strategy Configuration**
   - Customizable max retries
   - Adjustable backoff timing
   - Different strategies per error type

4. **Upload Analytics**
   - Success/failure rates
   - Average upload speeds
   - Chunk retry statistics

5. **Graceful Shutdown**
   - Save in-progress uploads before server restart
   - Notify clients of maintenance
   - Auto-resume after server comes back

### Scalability Enhancements
1. **Horizontal Scaling**
   - Load balancer support
   - Stateless backend servers
   - Shared storage (S3/NFS)

2. **Database Sharding**
   - Partition uploads by user/date
   - Better query performance
   - Handle millions of uploads

3. **Message Queue Integration**
   - RabbitMQ/Kafka for finalization
   - Asynchronous processing
   - Better resource utilization

4. **Microservices Architecture**
   - Separate upload, processing, storage services
   - Independent scaling
   - Technology flexibility

5. **Auto-scaling**
   - Kubernetes deployment
   - Auto-scale based on load
   - Cost optimization

### Monitoring & Observability
1. **Metrics Dashboard**
   - Prometheus/Grafana integration
   - Real-time upload metrics
   - System health monitoring

2. **Logging**
   - Structured logging (ELK stack)
   - Upload audit trails
   - Error tracking

3. **Alerting**
   - Failed upload notifications
   - Disk space warnings
   - Performance degradation alerts

4. **Distributed Tracing**
   - Track requests across services
   - Identify bottlenecks
   - Debug production issues

### User Experience
1. **Mobile Optimization**
   - Responsive design
   - Touch-friendly interface
   - Mobile network handling

2. **Internationalization**
   - Multi-language support
   - Localized error messages
   - Regional date/time formats

3. **Accessibility**
   - Screen reader support
   - Keyboard navigation
   - WCAG compliance

4. **Dark Mode**
   - Theme switching
   - System preference detection
   - Persistent preference

5. **Offline Support**
   - Service worker implementation
   - Queue uploads when offline
   - Sync when connection restored

## Setup Instructions

### Using Docker (Recommended)

1. Clone or extract the project
2. Navigate to the project directory
3. Start all services:

```bash
docker-compose up -d
```

4. Access the application:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001

### Manual Setup

#### Backend

```bash
cd backend
npm install
```

Create `.env` file:
```
MONGO_URI=mongodb+srv://your_user:your_password@cluster0.xxxxx.mongodb.net/file_uploader?retryWrites=true&w=majority&appName=Cluster0
PORT=3001
```

Note: The system is configured to use MongoDB Atlas cloud database. Update the MONGO_URI with your Atlas connection string.

Run the server:
```bash
npm start
```

#### Frontend

```bash
cd frontend
npm install
npm run dev
```

## API Endpoints

### POST /api/upload/init
Initialize a new upload or resume existing one.

**Request:**
```json
{
  "uploadId": "file.zip-1234567-1234567890",
  "filename": "file.zip",
  "fileSize": 1073741824
}
```

**Response:**
```json
{
  "uploadId": "file.zip-1234567-1234567890",
  "uploadedChunks": [0, 1, 5],
  "status": "UPLOADING"
}
```

### POST /api/upload/chunk
Upload a single chunk.

**Request (multipart/form-data):**
- `chunk`: Binary chunk data
- `uploadId`: Upload identifier
- `chunkIndex`: Chunk position (0-based)
- `totalChunks`: Total number of chunks

**Response:**
```json
{
  "success": true,
  "isComplete": false,
  "receivedChunks": 42,
  "totalChunks": 200
}
```

### GET /api/upload/:uploadId/status
Get upload status and chunk information.

**Response:**
```json
{
  "upload": {
    "id": "file.zip-1234567-1234567890",
    "filename": "file.zip",
    "total_size": 1073741824,
    "total_chunks": 200,
    "status": "COMPLETED",
    "final_hash": "abc123..."
  },
  "chunks": [
    {"chunk_index": 0, "status": "RECEIVED"},
    {"chunk_index": 1, "status": "RECEIVED"}
  ]
}
```

## Database Schema

### uploads collection
```javascript
{
  id: String (unique index),
  filename: String,
  total_size: Number,
  total_chunks: Number,
  status: String, // 'UPLOADING', 'PROCESSING', 'COMPLETED', 'FAILED'
  final_hash: String,
  created_at: Date,
  updated_at: Date
}
```

### chunks collection
```javascript
{
  upload_id: String (compound index with chunk_index),
  chunk_index: Number,
  status: String, // 'PENDING', 'RECEIVED'
  received_at: Date
}
```

## Key Design Decisions & Trade-offs

### Memory Management
- **Decision**: Use streaming for chunk uploads instead of loading in memory
- **Trade-off**: Slightly more complex code, but handles unlimited file sizes
- **Benefit**: Server can handle multiple large uploads without OOM errors

### Concurrency Model
- **Decision**: Limit to 3 concurrent chunk uploads
- **Trade-off**: Could be faster with more, but risks overwhelming server/network
- **Benefit**: Balanced throughput with stability

### Chunk Size (5MB)
- **Decision**: Fixed 5MB chunks
- **Trade-off**: Smaller chunks = more overhead, larger chunks = less granular retry
- **Benefit**: Good balance for network reliability and progress tracking

### Idempotency Approach
- **Decision**: Check database before writing each chunk
- **Trade-off**: Extra database query per chunk
- **Benefit**: Prevents file corruption from retries

### Database Choice (MongoDB)
- **Decision**: Use MongoDB for flexible document storage
- **Trade-off**: Eventual consistency model vs ACID transactions
- **Benefit**: Survives server restarts, flexible schema, easy to scale

### Finalization Race Condition Handling
- **Decision**: Check upload status before finalization
- **Trade-off**: Multiple final chunks may check simultaneously
- **Benefit**: Prevents duplicate finalization processing

## Testing Scenarios

The system handles these challenging scenarios:

1. **Network Flapping**: 30% simulated failure rate with automatic retry
2. **Out-of-Order Chunks**: Chunk 99 can arrive before chunk 1
3. **Page Refresh**: Upload continues after browser refresh
4. **Server Restart**: Upload resumes after backend crash
5. **Double Finalization**: Last chunks arriving simultaneously handled safely
6. **Partial Uploads**: Cleanup job removes abandoned uploads

## Future Improvements

1. **Performance**
   - Implement Redis caching for chunk status
   - Use WebSockets for real-time progress updates
   - Add CDN support for distributed uploads
   - Parallel chunk assembly for faster finalization

2. **Features**
   - Support for multiple simultaneous file uploads
   - Compression before upload
   - Client-side encryption
   - Thumbnail generation for ZIP contents
   - Download with resume support

3. **Reliability**
   - Configurable retry strategies
   - Circuit breaker for failing backends
   - Health check endpoints
   - Metrics and monitoring integration

4. **Security**
   - File type validation
   - Virus scanning integration
   - Rate limiting per IP
   - Authentication and authorization
   - Signed upload URLs

5. **Scalability**
   - Horizontal backend scaling
   - Database read replicas
   - S3/blob storage integration
   - Message queue for finalization

## Monitoring & Maintenance

### Cleanup Schedule
The system automatically cleans up:
- Incomplete uploads older than 24 hours
- Temporary files older than 1 hour

### Logs
Check logs for:
- Upload completion with hash verification
- ZIP content listing
- Finalization errors
- Cleanup operations

### Health Checks
Monitor:
- Database connectivity
- Disk space in upload directory
- Active upload count
- Failed upload rate

## Troubleshooting

### Upload Fails to Initialize
- Check MySQL connection
- Verify database exists and tables are created
- Check backend logs for errors

### Chunks Not Uploading
- Verify CORS settings
- Check network connectivity
- Review browser console for errors
- Ensure upload directory is writable

### High Memory Usage
- Verify streaming is working (not loading full chunks in memory)
- Check for memory leaks in long-running uploads
- Monitor temp file cleanup

### Database Growing Large
- Run cleanup job more frequently
- Implement archival for old completed uploads
- Add database retention policy

