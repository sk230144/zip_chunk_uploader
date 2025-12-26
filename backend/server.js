import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import yauzl from 'yauzl';
import { promisify } from 'util';
import { connectDatabase, getDatabase } from './database.js';

const app = express();
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = './uploads';
const TEMP_DIR = './temp';
const CHUNK_SIZE = 5 * 1024 * 1024;

const yauzlOpen = promisify(yauzl.open);

app.use(cors());
app.use(express.json());

const upload = multer({ dest: TEMP_DIR });

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(TEMP_DIR, { recursive: true });

await connectDatabase();

app.post('/api/upload/init', async (req, res) => {
  try {
    const { filename, fileSize, uploadId } = req.body;

    if (!filename || !fileSize || !uploadId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    const db = getDatabase();

    const existing = await db.collection('uploads').findOne({ id: uploadId });

    if (existing) {
      const chunks = await db.collection('chunks')
        .find({ upload_id: uploadId })
        .toArray();

      const uploadedChunks = chunks
        .filter(c => c.status === 'RECEIVED')
        .map(c => c.chunk_index);

      return res.json({
        uploadId,
        uploadedChunks,
        status: existing.status
      });
    }

    await db.collection('uploads').insertOne({
      id: uploadId,
      filename,
      total_size: fileSize,
      total_chunks: totalChunks,
      status: 'UPLOADING',
      final_hash: null,
      created_at: new Date(),
      updated_at: new Date()
    });

    const chunkDocs = [];
    for (let i = 0; i < totalChunks; i++) {
      chunkDocs.push({
        upload_id: uploadId,
        chunk_index: i,
        status: 'PENDING',
        received_at: null
      });
    }

    if (chunkDocs.length > 0) {
      await db.collection('chunks').insertMany(chunkDocs);
    }

    res.json({
      uploadId,
      uploadedChunks: [],
      status: 'UPLOADING'
    });
  } catch (error) {
    console.error('Init error:', error);
    res.status(500).json({ error: 'Failed to initialize upload' });
  }
});

app.post('/api/upload/chunk', upload.single('chunk'), async (req, res) => {
  const tempPath = req.file?.path;

  try {
    const { uploadId, chunkIndex, totalChunks } = req.body;

    if (!uploadId || chunkIndex === undefined || !totalChunks) {
      if (tempPath) await fs.unlink(tempPath);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const chunkIdx = parseInt(chunkIndex);
    const total = parseInt(totalChunks);
    const db = getDatabase();

    const uploadDoc = await db.collection('uploads').findOne({ id: uploadId });

    if (!uploadDoc) {
      if (tempPath) await fs.unlink(tempPath);
      return res.status(404).json({ error: 'Upload not found' });
    }

    const existingChunk = await db.collection('chunks').findOne({
      upload_id: uploadId,
      chunk_index: chunkIdx
    });

    if (existingChunk && existingChunk.status === 'RECEIVED') {
      if (tempPath) await fs.unlink(tempPath);
      return res.json({ success: true, message: 'Chunk already uploaded' });
    }

    const targetPath = path.join(UPLOAD_DIR, uploadId);
    const offset = chunkIdx * CHUNK_SIZE;

    const chunkData = await fs.readFile(tempPath);

    let fileHandle;
    try {
      fileHandle = await fs.open(targetPath, 'r+').catch(() =>
        fs.open(targetPath, 'w')
      );

      await fileHandle.write(chunkData, 0, chunkData.length, offset);
    } finally {
      if (fileHandle) await fileHandle.close();
    }

    await fs.unlink(tempPath);

    await db.collection('chunks').updateOne(
      { upload_id: uploadId, chunk_index: chunkIdx },
      { $set: { status: 'RECEIVED', received_at: new Date() } }
    );

    const allChunks = await db.collection('chunks')
      .find({ upload_id: uploadId })
      .toArray();

    const totalCount = allChunks.length;
    const receivedCount = allChunks.filter(c => c.status === 'RECEIVED').length;

    const isComplete = receivedCount === totalCount;

    if (isComplete) {
      await finalizeUpload(uploadId, targetPath, uploadDoc.filename);
    }

    res.json({
      success: true,
      isComplete,
      receivedChunks: receivedCount,
      totalChunks: totalCount
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    if (tempPath) {
      try {
        await fs.unlink(tempPath);
      } catch {}
    }
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

async function finalizeUpload(uploadId, filePath, filename) {
  const db = getDatabase();

  try {
    const uploadDoc = await db.collection('uploads').findOne({ id: uploadId });

    if (!uploadDoc || uploadDoc.status !== 'UPLOADING') {
      return;
    }

    await db.collection('uploads').updateOne(
      { id: uploadId },
      { $set: { status: 'PROCESSING', updated_at: new Date() } }
    );

    const hash = await calculateFileHash(filePath);

    let zipContents = [];
    try {
      zipContents = await peekZipContents(filePath);
    } catch (err) {
      console.error('ZIP peek failed:', err);
    }

    await db.collection('uploads').updateOne(
      { id: uploadId },
      { $set: { status: 'COMPLETED', final_hash: hash, updated_at: new Date() } }
    );

    console.log(`Upload ${uploadId} completed. Hash: ${hash}`);
    if (zipContents.length > 0) {
      console.log('ZIP contents:', zipContents.slice(0, 10));
    }
  } catch (error) {
    console.error('Finalization error:', error);

    await db.collection('uploads').updateOne(
      { id: uploadId },
      { $set: { status: 'FAILED', updated_at: new Date() } }
    );
  }
}

function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);

    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function peekZipContents(filePath) {
  return new Promise(async (resolve, reject) => {
    try {
      const zipfile = await yauzlOpen(filePath, { lazyEntries: true });
      const entries = [];

      zipfile.on('entry', (entry) => {
        if (!entry.fileName.includes('/') || entry.fileName.endsWith('/')) {
          entries.push(entry.fileName);
        }
        zipfile.readEntry();
      });

      zipfile.on('end', () => {
        zipfile.close();
        resolve(entries);
      });

      zipfile.on('error', reject);
      zipfile.readEntry();
    } catch (error) {
      reject(error);
    }
  });
}

app.get('/api/upload/:uploadId/status', async (req, res) => {
  try {
    const { uploadId } = req.params;
    const db = getDatabase();

    const uploadDoc = await db.collection('uploads').findOne({ id: uploadId });

    if (!uploadDoc) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const chunks = await db.collection('chunks')
      .find({ upload_id: uploadId })
      .toArray();

    res.json({
      upload: uploadDoc,
      chunks
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

async function cleanupOldUploads() {
  try {
    const db = getDatabase();
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const oldUploads = await db.collection('uploads')
      .find({
        status: { $in: ['UPLOADING', 'FAILED'] },
        created_at: { $lt: cutoffTime }
      })
      .toArray();

    for (const uploadDoc of oldUploads) {
      const filePath = path.join(UPLOAD_DIR, uploadDoc.id);
      try {
        await fs.unlink(filePath);
      } catch {}
    }

    await db.collection('uploads').deleteMany({
      status: { $in: ['UPLOADING', 'FAILED'] },
      created_at: { $lt: cutoffTime }
    });

    const tempFiles = await fs.readdir(TEMP_DIR);
    for (const file of tempFiles) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      if (Date.now() - stats.mtimeMs > 60 * 60 * 1000) {
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

setInterval(cleanupOldUploads, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
