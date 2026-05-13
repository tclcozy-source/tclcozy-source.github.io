// useState is a React "hook" — a special function that lets your component
// remember values between renders.
//
// HOW IT WORKS:
//   const [value, setValue] = useState(initialValue)
//
//   - value     → the current stored value (like a variable)
//   - setValue  → a function you call to change value
//   - When setValue is called, React re-renders the component with the new value
//
// Without useState, a plain variable resets to its initial value every render,
// so clicking a button would never visibly change anything on screen.

import { useState } from "react";

const styles = {
  page: {
    minHeight: "100vh",
    backgroundColor: "#1a1a2e",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "sans-serif",
    color: "#ffffff",
  },
  title: {
    color: "#e94560",
    fontSize: "2.5rem",
    marginBottom: "2rem",
  },
  score: {
    fontSize: "5rem",
    fontWeight: "bold",
    marginBottom: "2rem",
  },
  buttons: {
    display: "flex",
    gap: "1rem",
  },
  clickBtn: {
    backgroundColor: "#e94560",
    color: "#ffffff",
    border: "none",
    padding: "0.75rem 2rem",
    fontSize: "1.1rem",
    borderRadius: "8px",
    cursor: "pointer",
  },
  resetBtn: {
    backgroundColor: "transparent",
    color: "#e94560",
    border: "2px solid #e94560",
    padding: "0.75rem 2rem",
    fontSize: "1.1rem",
    borderRadius: "8px",
    cursor: "pointer",
  },
};

export default function App() {
  // Declare a state variable called "score", starting at 0.
  // React will remember this value even when the component re-renders.
  const [score, setScore] = useState(0);

  // Calling setScore(score + 1) tells React:
  //   "Update score to score+1, then re-render the component."
  // The UI updates automatically — you never touch the DOM directly.
  function handleClick() {
    setScore(score + 1);
  }

  // setScore(0) resets score back to the initial value.
  function handleReset() {
    setScore(0);
  }

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>My React App</h1>

      {/* score is just the current value from useState — React keeps it in sync */}
      <div style={styles.score}>{score}</div>

      <div style={styles.buttons}>
        <button style={styles.clickBtn} onClick={handleClick}>
          Click Me
        </button>
        <button style={styles.resetBtn} onClick={handleReset}>
          Reset
        </button>
      </div>
    </div>
  );
}
