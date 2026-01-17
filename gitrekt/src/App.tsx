import { useState, useEffect } from 'react'
import { createAuthClient } from "better-auth/react"
import { Github } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"

export const authClient = createAuthClient({
    baseURL: "http://localhost:3000"
})

function App() {
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const cb = params.get('callback_url')
    if (cb) {
      setCallbackUrl(cb)
    }
    // Set dark mode by default for the Gitrekt feel
    document.documentElement.classList.add('dark')
  }, [])

  async function handleLogin(): Promise<void> {
    setLoading(true)
    const successUrl = new URL("/success", window.location.origin)
    if (callbackUrl) {
      successUrl.searchParams.set('callback_url', callbackUrl)
    }

    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: successUrl.toString(),
      })
    } catch (error) {
      console.error("Login failed", error)
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <CardHeader className="text-center">
          <CardTitle className="text-4xl">Gitrekt</CardTitle>
          <CardDescription>Sign in to your account to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <Button 
            onClick={handleLogin} 
            disabled={loading}
            className="w-full"
            variant="default"
            size="lg"
          >
            <Github className="mr-2 h-5 w-5" />
            {loading ? "Connecting..." : "Continue with GitHub"}
          </Button>
        </CardContent>
        <CardFooter className="text-center flex justify-center border-t pt-6">
          <p className="text-xs text-muted-foreground">
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}

export default App
