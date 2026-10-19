'use client';

import { motion } from 'framer-motion';
import {
  Users,
  Shield,
  ClipboardList,
  Clock,
  KeyRound,
  MessageSquare,
} from 'lucide-react';

const features = [
  {
    icon: Users,
    title: 'Multi-Tenant',
    description:
      'Isolated organizations with tenant-scoped data and configurations.',
  },
  {
    icon: Shield,
    title: 'RBAC & Security',
    description: 'Four predefined roles with granular permissions.',
  },
  {
    icon: ClipboardList,
    title: 'Audit Logs',
    description:
      'Complete activity trail with filtering by event type and severity.',
  },
  {
    icon: Clock,
    title: 'Background Jobs',
    description:
      'pg-boss workers handle embedding generation and summaries.',
  },
  {
    icon: KeyRound,
    title: 'Google Auth',
    description:
      'NextAuth with Google OAuth SSO and credentials login.',
  },
  {
    icon: MessageSquare,
    title: 'Chat Widget SDK',
    description:
      'Embeddable chat widget for external apps and websites.',
  },
];

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export function FeatureGrid() {
  return (
    <section className="max-w-5xl mx-auto px-6 py-24">
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
        variants={container}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: '-80px' }}
      >
        {features.map((feature) => (
          <motion.div
            key={feature.title}
            variants={item}
            whileHover={{ y: -4 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            className="bg-[#111113] border border-[#27272a] rounded-xl p-6 h-full hover:border-[#3f3f46] transition-colors"
          >
            <div className="inline-flex items-center justify-center rounded-lg bg-[#6366f1]/10 p-2.5">
              <feature.icon className="h-5 w-5 text-[#6366f1]" />
            </div>
            <h3 className="text-sm font-semibold text-[#fafafa] mt-4">
              {feature.title}
            </h3>
            <p className="text-xs text-[#71717a] mt-1.5 leading-relaxed">
              {feature.description}
            </p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
