// src/index.js
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import LoanApplication from "./App";

const container = document.getElementById("root");

const root = createRoot(container);
root.render(<LoanApplication />);
