/**
 * Tests for the tmux-lite session framed protocol
 */
import { describe, it, expect } from "bun:test";
import {
  FrameType,
  encodeFrame,
  encodePTY,
  encodeControl,
  parseFrames,
  decodeControl,
  type SessionCtrl,
  type SessionEvent,
  type SessionFrame,
} from "./protocol";

describe("protocol", () => {
  describe("encodeFrame", () => {
    it("encodes a PTY frame with correct header", () => {
      const payload = Buffer.from("hello");
      const frame = encodeFrame(FrameType.PTY, payload);

      // Header: 1 byte type + 4 bytes length
      expect(frame.length).toBe(5 + payload.length);
      expect(frame[0]).toBe(FrameType.PTY); // type
      expect(frame.readUInt32BE(1)).toBe(payload.length); // length
      expect(frame.subarray(5).toString()).toBe("hello"); // payload
    });

    it("encodes a CONTROL frame with correct header", () => {
      const payload = Buffer.from('{"type":"resize"}');
      const frame = encodeFrame(FrameType.CONTROL, payload);

      expect(frame.length).toBe(5 + payload.length);
      expect(frame[0]).toBe(FrameType.CONTROL);
      expect(frame.readUInt32BE(1)).toBe(payload.length);
      expect(frame.subarray(5).toString()).toBe('{"type":"resize"}');
    });

    it("handles empty payload", () => {
      const frame = encodeFrame(FrameType.PTY, Buffer.alloc(0));

      expect(frame.length).toBe(5);
      expect(frame[0]).toBe(FrameType.PTY);
      expect(frame.readUInt32BE(1)).toBe(0);
    });

    it("handles Uint8Array payload", () => {
      const payload = new Uint8Array([1, 2, 3, 4, 5]);
      const frame = encodeFrame(FrameType.PTY, payload);

      expect(frame.length).toBe(5 + 5);
      expect(frame.subarray(5)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    });
  });

  describe("encodePTY", () => {
    it("wraps data in a PTY frame", () => {
      const data = Buffer.from("terminal output");
      const frame = encodePTY(data);

      expect(frame[0]).toBe(FrameType.PTY);
      expect(frame.subarray(5).toString()).toBe("terminal output");
    });
  });

  describe("encodeControl", () => {
    it("encodes resize message", () => {
      const msg: SessionCtrl = { type: "resize", cols: 120, rows: 40 };
      const frame = encodeControl(msg);

      expect(frame[0]).toBe(FrameType.CONTROL);
      const payload = frame.subarray(5).toString();
      expect(JSON.parse(payload)).toEqual(msg);
    });

    it("encodes attach-init message", () => {
      const msg: SessionCtrl = { type: "attach-init", cols: 80, rows: 24, clientType: "cli" };
      const frame = encodeControl(msg);

      expect(frame[0]).toBe(FrameType.CONTROL);
      const payload = frame.subarray(5).toString();
      expect(JSON.parse(payload)).toEqual(msg);
    });

    it("encodes detach message", () => {
      const msg: SessionCtrl = { type: "detach" };
      const frame = encodeControl(msg);

      expect(frame[0]).toBe(FrameType.CONTROL);
      const payload = frame.subarray(5).toString();
      expect(JSON.parse(payload)).toEqual(msg);
    });

    it("encodes exited event", () => {
      const msg: SessionEvent = { type: "exited", code: 0 };
      const frame = encodeControl(msg);

      expect(frame[0]).toBe(FrameType.CONTROL);
      const payload = frame.subarray(5).toString();
      expect(JSON.parse(payload)).toEqual(msg);
    });

    it("encodes kicked event", () => {
      const msg: SessionEvent = { type: "kicked" };
      const frame = encodeControl(msg);

      expect(frame[0]).toBe(FrameType.CONTROL);
      const payload = frame.subarray(5).toString();
      expect(JSON.parse(payload)).toEqual(msg);
    });
  });

  describe("parseFrames", () => {
    it("parses a single complete frame", () => {
      const frame = encodePTY(Buffer.from("hello"));
      const result = parseFrames(frame);

      expect(result.frames.length).toBe(1);
      expect(result.frames[0].type).toBe(FrameType.PTY);
      expect(result.frames[0].payload.toString()).toBe("hello");
      expect(result.remaining.length).toBe(0);
    });

    it("parses multiple complete frames", () => {
      const frame1 = encodePTY(Buffer.from("first"));
      const frame2 = encodeControl({ type: "resize", cols: 80, rows: 24 });
      const frame3 = encodePTY(Buffer.from("third"));

      const combined = Buffer.concat([frame1, frame2, frame3]);
      const result = parseFrames(combined);

      expect(result.frames.length).toBe(3);
      expect(result.frames[0].type).toBe(FrameType.PTY);
      expect(result.frames[0].payload.toString()).toBe("first");
      expect(result.frames[1].type).toBe(FrameType.CONTROL);
      expect(result.frames[2].type).toBe(FrameType.PTY);
      expect(result.frames[2].payload.toString()).toBe("third");
      expect(result.remaining.length).toBe(0);
    });

    it("handles incomplete frame (missing payload)", () => {
      const frame = encodePTY(Buffer.from("hello world"));
      // Only send header + partial payload
      const partial = frame.subarray(0, 8);
      const result = parseFrames(partial);

      expect(result.frames.length).toBe(0);
      expect(result.remaining.length).toBe(8);
      expect(result.remaining).toEqual(partial);
    });

    it("handles incomplete header", () => {
      const frame = encodePTY(Buffer.from("hello"));
      // Only send 3 bytes (incomplete header)
      const partial = frame.subarray(0, 3);
      const result = parseFrames(partial);

      expect(result.frames.length).toBe(0);
      expect(result.remaining.length).toBe(3);
    });

    it("handles empty buffer", () => {
      const result = parseFrames(Buffer.alloc(0));

      expect(result.frames.length).toBe(0);
      expect(result.remaining.length).toBe(0);
    });

    it("returns remaining bytes after complete frames", () => {
      const frame1 = encodePTY(Buffer.from("complete"));
      const frame2 = encodePTY(Buffer.from("incomplete"));
      const partial2 = frame2.subarray(0, 7); // incomplete second frame

      const combined = Buffer.concat([frame1, partial2]);
      const result = parseFrames(combined);

      expect(result.frames.length).toBe(1);
      expect(result.frames[0].payload.toString()).toBe("complete");
      expect(result.remaining.length).toBe(7);
    });

    it("rejects oversized frames", () => {
      // Create a frame header claiming 2MB payload (over 1MB limit)
      const header = Buffer.alloc(5);
      header.writeUInt8(FrameType.PTY, 0);
      header.writeUInt32BE(2 * 1024 * 1024, 1);

      expect(() => parseFrames(header)).toThrow(/exceeds maximum/);
    });

    it("rejects invalid frame types", () => {
      // Create a frame header with invalid type (0xFF)
      const header = Buffer.alloc(10);
      header.writeUInt8(0xFF, 0); // Invalid type
      header.writeUInt32BE(5, 1); // 5 bytes payload
      header.write("hello", 5);

      expect(() => parseFrames(header)).toThrow(/Invalid frame type.*protocol desync/);
    });
  });

  describe("decodeControl", () => {
    it("decodes resize message", () => {
      const json = JSON.stringify({ type: "resize", cols: 100, rows: 50 });
      const msg = decodeControl(Buffer.from(json)) as SessionCtrl;

      expect(msg.type).toBe("resize");
      if (msg.type === "resize") {
        expect(msg.cols).toBe(100);
        expect(msg.rows).toBe(50);
      }
    });

    it("decodes exited event", () => {
      const json = JSON.stringify({ type: "exited", code: 1 });
      const msg = decodeControl(Buffer.from(json)) as SessionEvent;

      expect(msg.type).toBe("exited");
      if (msg.type === "exited") {
        expect(msg.code).toBe(1);
      }
    });

    it("throws on invalid JSON", () => {
      expect(() => decodeControl(Buffer.from("not json"))).toThrow();
    });
  });

  describe("round-trip", () => {
    it("encodes and parses PTY data correctly", () => {
      const original = Buffer.from("Hello, terminal!\x1b[32mGreen\x1b[0m");
      const frame = encodePTY(original);
      const { frames } = parseFrames(frame);

      expect(frames.length).toBe(1);
      expect(frames[0].type).toBe(FrameType.PTY);
      expect(frames[0].payload).toEqual(original);
    });

    it("encodes and parses control messages correctly", () => {
      const original: SessionCtrl = { type: "attach-init", cols: 120, rows: 40, clientType: "web" };
      const frame = encodeControl(original);
      const { frames } = parseFrames(frame);

      expect(frames.length).toBe(1);
      expect(frames[0].type).toBe(FrameType.CONTROL);

      const decoded = decodeControl(frames[0].payload);
      expect(decoded).toEqual(original);
    });

    it("handles binary data with all byte values", () => {
      // Create buffer with all possible byte values
      const original = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) {
        original[i] = i;
      }

      const frame = encodePTY(original);
      const { frames } = parseFrames(frame);

      expect(frames[0].payload).toEqual(original);
    });

    it("handles data that looks like old CTRL_MAGIC", () => {
      // ESC ] 9 9 - the old magic bytes that caused collisions with OSC 99
      const oscSequence = Buffer.from([0x1b, 0x5d, 0x39, 0x39, 0x3b, 0x74, 0x65, 0x73, 0x74, 0x07]);
      const frame = encodePTY(oscSequence);
      const { frames } = parseFrames(frame);

      expect(frames.length).toBe(1);
      expect(frames[0].type).toBe(FrameType.PTY);
      expect(frames[0].payload).toEqual(oscSequence);
    });
  });

  describe("streaming simulation", () => {
    it("handles data arriving in chunks", () => {
      // Simulate streaming: multiple frames arriving in arbitrary chunks
      const frame1 = encodePTY(Buffer.from("first message"));
      const frame2 = encodeControl({ type: "resize", cols: 80, rows: 24 });
      const frame3 = encodePTY(Buffer.from("second message"));

      const allData = Buffer.concat([frame1, frame2, frame3]);

      // Simulate receiving in 7-byte chunks
      let buffer: Buffer = Buffer.alloc(0);
      const allFrames: SessionFrame[] = [];

      for (let i = 0; i < allData.length; i += 7) {
        const chunk = allData.subarray(i, Math.min(i + 7, allData.length));
        buffer = Buffer.concat([buffer, chunk]);

        const { frames, remaining } = parseFrames(buffer);
        allFrames.push(...frames);
        buffer = remaining;
      }

      expect(allFrames.length).toBe(3);
      expect(allFrames[0].payload.toString()).toBe("first message");
      expect(allFrames[1].type).toBe(FrameType.CONTROL);
      expect(allFrames[2].payload.toString()).toBe("second message");
      expect(buffer.length).toBe(0);
    });
  });
});
