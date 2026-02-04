import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

function App() {
  const [connectionStatus, setConnectionStatus] = useState('Connecting...')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Test IPC connection on component mount
    const testConnection = async () => {
      try {
        console.log('Testing IPC connection...')
        const result = await invoke('get_projects')
        console.log('IPC response:', result)
        setConnectionStatus('Connected')
        setError(null)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        console.error('IPC connection error:', errorMsg)
        setError(errorMsg)
        setConnectionStatus('Connection Error')
      }
    }

    testConnection()
  }, [])

  return (
    <div className="app">
      <h1>GSD Agent Orchestrator</h1>
      <p>Desktop orchestration tool for managing autonomous AI coding agents</p>

      <div className="app-status">
        <span className={`status-indicator${error ? ' error' : ''}`}></span>
        <span>Status: {connectionStatus}</span>
      </div>

      {error && (
        <div style={{ margin: '10px 20px', padding: '8px 12px', backgroundColor: '#ffebee', borderRadius: '4px', color: '#c62828' }}>
          <strong>Connection Error:</strong> {error}
        </div>
      )}

      <button onClick={() => testConnection()}>
        Test IPC Connection
      </button>
    </div>
  )

  async function testConnection() {
    try {
      console.log('Testing IPC connection...')
      const result = await invoke('get_projects')
      console.log('IPC response:', result)
      setConnectionStatus('Connected')
      setError(null)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error('IPC connection error:', errorMsg)
      setError(errorMsg)
      setConnectionStatus('Connection Error')
    }
  }
}

export default App
