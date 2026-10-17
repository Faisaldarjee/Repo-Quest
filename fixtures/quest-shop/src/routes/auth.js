import { login } from "../services/auth-service.js";
import { trace } from "../trace.js";

export function handleLoginRequest(payload) {
  trace("auth.route");
  return login(payload.username, payload.password);
}
