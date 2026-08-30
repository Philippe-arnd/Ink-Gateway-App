import { Navigate, Route, Routes } from "react-router-dom";
import { Login, ResetPassword } from "./pages/Login";
import { Books } from "./pages/Books";
import { Editor } from "./pages/Editor";
import { Settings } from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/books" element={<Books />} />
      <Route path="/books/:id" element={<Editor />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<Navigate to="/books" replace />} />
    </Routes>
  );
}
