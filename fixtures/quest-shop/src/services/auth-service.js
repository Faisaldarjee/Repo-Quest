import { trace } from "../trace.js";

const USERS = [{ id: "u-1", username: "faisal", password: "quest" }];

export function login(username, password, users = USERS) {
  trace("auth-service.login");
  const user = users.find((candidate) => candidate.username === username);

  if (!user || user.password !== password) {
    return { status: 401, body: { error: "invalid credentials" } };
  }

  return { status: 200, body: { userId: user.id } };
}
