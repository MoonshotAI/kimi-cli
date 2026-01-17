import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { authClient } from './App'

function Success() {
  const [searchParams] = useSearchParams()
  const [status, setStatus] = useState("Authenticating...")

  useEffect(() => {
    async function handleRedirect(): Promise<void> {
      const { data: session } = await authClient.getSession()
      const callbackUrl = searchParams.get('callback_url')

      if (!session) {
        setStatus("Session not found. Please try again.")
        return
      }

      if (!callbackUrl) {
        setStatus("Login successful!")
        setTimeout(() => { window.location.href = "/" }, 2000)
        return
      }

      setStatus("Redirecting back to CLI...")
      const redirectUrl = new URL(callbackUrl)
      redirectUrl.searchParams.set('token', session.session.token)
      window.location.href = redirectUrl.toString()
    }

    handleRedirect()
  }, [searchParams])

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full text-center space-y-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-foreground mx-auto"></div>
        <h1 className="text-2xl font-semibold">{status}</h1>
        <p className="text-muted-foreground">Please do not close this window.</p>
      </div>
    </div>
  )
}

export default Success
