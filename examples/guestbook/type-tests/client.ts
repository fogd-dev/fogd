import { fetch } from 'void/client';
import { useForm } from '@void/react';

// Compile-time contract checks. These are not imported by the application.
async function checkClient() {
  const messages = await fetch('/api/messages');
  const text: string = messages[0].text;
  // @ts-expect-error Schema field remains a string through the generated client.
  const wrong: number = messages[0].text;
  // @ts-expect-error Unknown route names must not silently accept a plain fetch.
  await fetch('/api/not-a-route');
  return { text, wrong };
}

function checkForm() {
  const form = useForm('/', { text: '' });
  // @ts-expect-error Validator input is a string, not a numeric value.
  form.setData('text', 42);
  return form;
}

export type ClientContract = ReturnType<typeof checkClient>;
export type FormContract = ReturnType<typeof checkForm>;
