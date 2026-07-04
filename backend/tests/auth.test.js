const request = require('supertest');
const { createApp } = require('../src/app');
const { truncateAll, closeDb } = require('./helpers');

const app = createApp();

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

describe('Auth', () => {
  test('registers a new user and returns a token', async () => {
    const res = await request(app).post('/api/auth/register')
      .send({ email: 'a@example.com', password: 'password123', name: 'Alice' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe('a@example.com');
  });

  test('rejects duplicate email registration', async () => {
    await request(app).post('/api/auth/register').send({ email: 'a@example.com', password: 'password123', name: 'Alice' });
    const res = await request(app).post('/api/auth/register').send({ email: 'a@example.com', password: 'password123', name: 'Alice2' });
    expect(res.status).toBe(409);
  });

  test('rejects weak password at validation layer', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'b@example.com', password: '123', name: 'Bob' });
    expect(res.status).toBe(400);
  });

  test('logs in with correct credentials and rejects wrong password', async () => {
    await request(app).post('/api/auth/register').send({ email: 'c@example.com', password: 'password123', name: 'Carl' });
    const good = await request(app).post('/api/auth/login').send({ email: 'c@example.com', password: 'password123' });
    expect(good.status).toBe(200);

    const bad = await request(app).post('/api/auth/login').send({ email: 'c@example.com', password: 'wrongpass' });
    expect(bad.status).toBe(401);
  });

  test('rejects requests to protected routes without a token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
