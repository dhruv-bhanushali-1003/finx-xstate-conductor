// app/api/tasks/route.js
import axios from "axios";

const BASE_URL = "http://52.66.238.28:8127/api/tasks";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const query = url.search;
    const res = await axios.get(`${BASE_URL}${query}`);
    return new Response(JSON.stringify(res.data), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const res = await axios.post(BASE_URL, body);
    return new Response(JSON.stringify(res.data), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

export async function GET(req) {
  return new Response(JSON.stringify({ hello: "world" }), { status: 200 });
}
