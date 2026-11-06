import { describe, it, expect } from "vitest";

import { createTransport, createMultiTransport } from "../../src/transport/transport.js";

describe("createTransport: validation", () => {
    it("throws for file transport without destination", () => {
        expect(() => createTransport({ target: "file" })).toThrow(
            "File transport requires a destination path",
        );
    });

    it("throws for stream transport without destination", () => {
        expect(() => createTransport({ target: "stream" })).toThrow(
            "Stream transport requires a writable stream",
        );
    });

    it("throws for unknown target", () => {
        expect(() => createTransport({ target: "unknown" as any })).toThrow(
            "Unknown transport target",
        );
    });

    it("rejects a non-writable object as a stream destination", () => {
        expect(() =>
            createTransport({ target: "stream", destination: {} as any }),
        ).toThrow("Stream transport requires a writable stream");
    });
});

describe("createTransport: pretty target", () => {
    it("creates pretty transport with defaults", () => {
        const transport = createTransport({ target: "pretty" });
        expect(transport.targets).toHaveLength(1);
        expect((transport.targets[0] as any).target).toBe("pino-pretty");
    });

    it("honors destination for pretty target", () => {
        const transport = createTransport({
            target: "pretty",
            destination: "/tmp/pretty.log",
        });
        const options = (transport.targets[0] as any).options as Record<string, unknown>;
        expect(options.destination).toBe("/tmp/pretty.log");
    });

    it("honors an explicit level", () => {
        const transport = createTransport({ target: "pretty", level: "warn" });
        expect((transport.targets[0] as any).level).toBe("warn");
    });
});

describe("createTransport: file target", () => {
    it("creates file transport with destination", () => {
        const transport = createTransport({ target: "file", destination: "/tmp/app.log" });
        expect(transport.targets).toHaveLength(1);
        expect((transport.targets[0] as any).target).toBe("pino/file");
    });

    it("passes target options to file transport", () => {
        const transport = createTransport({
            target: "file",
            destination: "/tmp/app.log",
            options: { mkdir: true },
        });
        const options = (transport.targets[0] as any).options as Record<string, unknown>;
        expect(options.destination).toBe("/tmp/app.log");
        expect(options.mkdir).toBe(true);
    });
});

describe("createMultiTransport: validation", () => {
    it("throws for empty transport list", () => {
        expect(() => createMultiTransport([])).toThrow(
            "createMultiTransport requires at least one transport",
        );
    });

    it("throws for non-array", () => {
        expect(() => createMultiTransport(null as any)).toThrow(
            "createMultiTransport requires at least one transport",
        );
    });
});

describe("createMultiTransport: composition", () => {
    it("creates multiple targets with per-target levels", () => {
        const transport = createMultiTransport([
            { target: "pretty", level: "info" },
            { target: "file", destination: "/tmp/debug.log", level: "debug" },
        ]);

        expect(transport.targets).toHaveLength(2);
        expect((transport.targets[0] as any).level).toBe("info");
        expect((transport.targets[1] as any).level).toBe("debug");
    });

    it("preserves per-target destinations", () => {
        const transport = createMultiTransport([
            { target: "pretty", destination: "/tmp/a.log", level: "info" },
            { target: "file", destination: "/tmp/b.log", level: "debug" },
        ]);

        const first = (transport.targets[0] as any).options as Record<string, unknown>;
        const second = (transport.targets[1] as any).options as Record<string, unknown>;
        expect(first.destination).toBe("/tmp/a.log");
        expect(second.destination).toBe("/tmp/b.log");
    });
});
