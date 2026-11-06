import { describe, it, expect, vi, afterEach } from "vitest";
import { Writable } from "node:stream";

import { createTransportInstance, registerGracefulShutdown } from "../../src/transport/lifecycle.js";
import { createTransport } from "../../src/transport/transport.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("createTransportInstance: lifecycle", () => {
    it("wraps a transport with flush and close methods", () => {
        const transport = createTransportInstance({
            target: "pretty",
        });

        expect(typeof transport.flush).toBe("function");
        expect(typeof transport.close).toBe("function");
        expect(transport.write).toBeDefined();
    });

    it("flush resolves immediately for transports without flush", async () => {
        const transport = createTransportInstance({
            target: "pretty",
        });

        await expect(transport.flush()).resolves.toBeUndefined();
    });

    it("close resolves immediately for transports without end", async () => {
        const transport = createTransportInstance({
            target: "pretty",
        });

        await expect(transport.close()).resolves.toBeUndefined();
    });
});

describe("createTransportInstance: file transport", () => {
    it("creates a file transport instance with lifecycle", () => {
        const transport = createTransportInstance({
            target: "file",
            destination: "/tmp/test-shutdown.log",
        });

        expect(transport.flush).toBeDefined();
        expect(transport.close).toBeDefined();
    });
});

describe("registerGracefulShutdown", () => {
    it("flushes and closes on SIGTERM", async () => {
        const flush = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn().mockResolvedValue(undefined);

        const transport = {
            flush,
            close,
            write: () => true,
        } as any;

        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

        const cleanup = registerGracefulShutdown(transport, { exitCode: 0 });

        // Emit SIGTERM
        process.emit("SIGTERM");

        // Allow microtasks to run
        await new Promise((resolve) => setImmediate(resolve));

        expect(flush).toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);

        cleanup();
    });

    it("handles SIGINT", async () => {
        const flush = vi.fn().mockResolvedValue(undefined);
        const close = vi.fn().mockResolvedValue(undefined);

        const transport = {
            flush,
            close,
            write: () => true,
        } as any;

        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

        const cleanup = registerGracefulShutdown(transport);

        process.emit("SIGINT");

        await new Promise((resolve) => setImmediate(resolve));

        expect(flush).toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);

        cleanup();
    });

    it("cleanup removes signal handlers", () => {
        const transport = {
            flush: () => Promise.resolve(),
            close: () => Promise.resolve(),
            write: () => true,
        } as any;

        const cleanup = registerGracefulShutdown(transport);
        cleanup();

        // After cleanup, emitting SIGTERM should not trigger the handler
        const flushSpy = vi.spyOn(transport, "flush");
        process.emit("SIGTERM");
        expect(flushSpy).not.toHaveBeenCalled();
    });

    it("uses custom exit code", async () => {
        const transport = {
            flush: () => Promise.resolve(),
            close: () => Promise.resolve(),
            write: () => true,
        } as any;

        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

        registerGracefulShutdown(transport, { exitCode: 1 });

        process.emit("SIGTERM");
        await new Promise((resolve) => setImmediate(resolve));

        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

describe("createTransport: lifecycle-compatible options", () => {
    it("accepts autoFlush option", () => {
        const transport = createTransport({
            target: "pretty",
            autoFlush: true,
        });

        expect(transport.targets).toHaveLength(1);
    });
});
