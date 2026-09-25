import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
    GENERATED_CLIENT_PATH,
    SUPPORTED_NODE_VERSIONS,
    assertValidRuntime,
    findRuntimeProblems,
    nodeSupportsTypeStripping,
} from "../src/config/runtime.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));

describe("M3: runtime check", () => {
    test("Node versions that load the generated .ts client", () => {
        for (const version of ["22.18.0", "v22.20.1", "23.6.0", "23.11.0", "24.0.0", "26.1.0"]) {
            assert.equal(nodeSupportsTypeStripping(version), true, version);
        }
        for (const version of ["20.19.0", "22.17.1", "22.0.0", "23.5.0", "18.20.0", "", "abc"]) {
            assert.equal(nodeSupportsTypeStripping(version), false, version);
        }
    });

    test("an old Node version or a missing generated client is reported clearly", () => {
        assert.deepEqual(findRuntimeProblems({ nodeVersion: "22.18.0", clientExists: true }), []);
        const problems = findRuntimeProblems({ nodeVersion: "20.11.0", clientExists: false });
        assert.equal(problems.length, 2);
        assert.match(problems[0], /Node\.js 20\.11\.0 is not supported/);
        assert.match(problems[1], /npx prisma generate/);
        assert.throws(() => assertValidRuntime({ nodeVersion: "22.17.0", clientExists: true }), /Invalid runtime/);
    });

    test("this checkout passes (the client is generated, Node is supported)", () => {
        assert.deepEqual(findRuntimeProblems(), []);
        assert.ok(GENERATED_CLIENT_PATH.replace(/\\/g, "/").endsWith("generated/prisma/client.ts"));
    });

    test("the server checks the runtime before loading anything that imports the client", () => {
        const app = read("src/app.js");
        const check = app.indexOf("assertValidRuntime();");
        assert.ok(check > 0);
        assert.ok(check < app.indexOf('await import("./createApp.js")'));
        assert.ok(!/^import .*createApp|^import .*prisma/m.test(app), "no static import of the app or the client");
    });
});

describe("M3: fresh install and production install generate the client", () => {
    test("npm install runs prisma generate (postinstall)", () => {
        assert.equal(pkg.scripts.postinstall, "prisma generate");
    });

    test("the prisma CLI is a runtime dependency, so `npm ci --omit=dev` can generate", () => {
        assert.equal(pkg.dependencies.prisma, pkg.dependencies["@prisma/client"]);
        assert.equal(pkg.devDependencies?.prisma, undefined);
        assert.equal(lock.packages[""].dependencies.prisma, pkg.dependencies.prisma);
        assert.notEqual(lock.packages["node_modules/prisma"].dev, true);
        assert.notEqual(lock.packages["node_modules/prisma"].devOptional, true);
    });

    test("the supported Node versions are declared (engines) and match the startup check", () => {
        assert.equal(pkg.engines.node, SUPPORTED_NODE_VERSIONS);
        assert.equal(lock.packages[""].engines.node, SUPPORTED_NODE_VERSIONS);
    });

    test("the generated client stays out of git and is generated where the code imports it", () => {
        assert.match(read(".gitignore"), /^\/generated\/prisma$/m);
        assert.match(read("prisma/schema.prisma"), /output\s*=\s*"\.\.\/generated\/prisma"/);
        assert.match(read("src/config/prisma.js"), /generated\/prisma\/client\.ts/);
    });
});
