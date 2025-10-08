// app/api/workflow/route.js
import axios from "axios";

const BASE_URL = "http://52.66.238.28:8127/api/workflow";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const query = url.search; // keep query params
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
