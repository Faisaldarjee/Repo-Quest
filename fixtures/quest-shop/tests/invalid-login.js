import assert from "node:assert/strict";
import { handleLoginRequest } from "../src/routes/auth.js";

const response = handleLoginRequest({ username: "missing", password: "wrong" });
assert.equal(response.status, 401, "unknown users must receive a 401 response");
console.log("invalid login regression passed");
